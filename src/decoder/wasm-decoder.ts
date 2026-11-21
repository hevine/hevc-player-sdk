import Worker from './decoder.worker?worker&inline';
import type { FromWorkerMessage, ToWorkerMessage } from './protocol';
import type { VideoFrameData } from '../types';
import { playerError } from '../errors';
import type { Logger } from '../core/logger';

export interface DecoderCallbacks {
  onReady: (version: string) => void;
  onFrame: (frame: VideoFrameData) => void;
  onError: (err: ReturnType<typeof playerError.decode>) => void;
}

/**
 * WASM 解码器主线程代理
 * ------------------------------------------------------------------
 * 封装 Worker 生命周期与消息路由。提供背压：awaitDrain() 在在途解码
 * 请求超过阈值时等待，防止 producer 无限推送导致内存膨胀。
 * 所有异步请求携带 generation，destroy/reset 后旧请求回调被丢弃，
 * 避免 StrictMode 重复挂载/重建时的竞态（对应交接文档 P0-1 单例串台问题）。
 */
export class WasmDecoder {
  private worker: Worker | null = null;
  private readonly callbacks: DecoderCallbacks;
  private readonly log: Logger;
  private generation = 0;
  private inFlight = 0;
  private readonly maxInFlight: number;
  private waiters: Array<() => void> = [];
  private readyPromise: Promise<string> | null = null;
  private destroyPromise: Promise<void> | null = null;

  constructor(callbacks: DecoderCallbacks, log: Logger, maxInFlight = 12) {
    this.callbacks = callbacks;
    this.log = log.child('decoder');
    this.maxInFlight = maxInFlight;
  }

  get isReady(): boolean {
    return this.worker !== null && this.readyPromise !== null;
  }

  /** 初始化 WASM 解码器，返回 libde265 版本。可重复调用（幂等）。 */
  init(): Promise<string> {
    if (this.readyPromise) return this.readyPromise;
    const gen = this.generation;
    this.readyPromise = new Promise<string>((resolve, reject) => {
      let worker: Worker;
      try {
        // ?worker&inline：Vite 把 worker + wasm 内联为 blob，SDK 自包含
        worker = new Worker();
      } catch (err) {
        reject(playerError.unsupported(`Web Worker 创建失败: ${String(err)}`));
        return;
      }
      this.worker = worker;
      const onMessage = (event: MessageEvent<FromWorkerMessage>) => {
        if (gen !== this.generation) return; // 过期 worker 消息
        const msg = event.data;
        switch (msg.type) {
          case 'ready':
            this.log.info('WASM 解码器就绪', { version: msg.version });
            this.callbacks.onReady(msg.version);
            resolve(msg.version);
            break;
          case 'frame':
            this.callbacks.onFrame(msg.frame);
            break;
          case 'ack':
            this.release(); // 每个 access unit 完成释放一个背压信用
            break;
          case 'flushed':
            break; // flush 不占背压信用，ack 已负责释放
          case 'error':
            this.log.error('WASM 解码器错误', { message: msg.message });
            this.callbacks.onError(
              msg.code === 'UNSUPPORTED'
                ? playerError.unsupported(msg.message)
                : playerError.decode(msg.message),
            );
            break;
        }
      };
      const onError = (event: ErrorEvent) => {
        if (gen !== this.generation) return;
        this.callbacks.onError(playerError.decode(event.message || 'Worker runtime error'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.post({ type: 'init' });
    });
    return this.readyPromise;
  }

  /** 提交一个 access unit（一组 NALU）解码 */
  decode(nals: Uint8Array[], ptsUs: number, key = false): void {
    if (!this.worker) return;
    this.inFlight++;
    // 关键：每个 NALU 必须复制到独立 ArrayBuffer 再 transfer。
    // demuxer 产出的 NALU 可能是共享底层 buffer 的视图（subarray），
    // 直接 transfer 会在第一个后 detach，导致后续 DataCloneError。
    const detached = nals.map((n) => new Uint8Array(n));
    this.post({ type: 'decode', nals: detached, ptsUs, key }, detached.map((n) => n.buffer));
  }

  /** 冲刷解码器中的重排帧（流结束 / seek 后调用） */
  flush(): void {
    if (this.worker) this.post({ type: 'flush' });
  }

  /** 复位解码器（seek 后清空参考帧） */
  reset(): void {
    if (!this.worker) return;
    this.generation++;
    this.inFlight = 0;
    this.drainWaiters();
    this.post({ type: 'reset' });
  }

  /** 背压：在途请求过多时等待释放 */
  async awaitDrain(): Promise<void> {
    while (this.inFlight >= this.maxInFlight && this.worker) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.drainWaiters();
  }

  private drainWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private post(msg: ToWorkerMessage, transfer?: Transferable[]): void {
    if (!this.worker) return;
    try {
      this.worker.postMessage(msg, transfer ?? []);
    } catch (err) {
      this.callbacks.onError(playerError.decode(`Worker postMessage 失败: ${String(err)}`));
    }
  }

  /** 彻底销毁：终止 worker，泄漏任何在途请求 */
  async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.generation++;
    this.inFlight = 0;
    this.drainWaiters();
    this.destroyPromise = new Promise<void>((resolve) => {
      const worker = this.worker;
      this.worker = null;
      this.readyPromise = null;
      if (!worker) {
        resolve();
        return;
      }
      const done = () => {
        worker.terminate();
        resolve();
      };
      worker.addEventListener('message', (e: MessageEvent<FromWorkerMessage>) => {
        if (e.data.type === 'flushed') done();
      });
      this.post({ type: 'destroy' });
      // 兜底超时：worker 若不响应 flushed 仍强制终止
      setTimeout(done, 300);
    });
    return this.destroyPromise;
  }
}
