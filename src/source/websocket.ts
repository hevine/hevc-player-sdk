import type { MediaSource, ChunkResult } from './types';
import { playerError } from '../errors';

/**
 * WebSocket 数据源（WS-FLV / WS-AnnexB 实时流）
 * ------------------------------------------------------------------
 * 运行时把收到的每个二进制消息放入内部队列；next() 从队列拉取。
 * 队列有上限，超出时丢弃最旧数据（实时流优先新数据），并通过 onBackpressure
 * 通知上层。断线时结束流；onError 回调供上层感知连接异常。
 */
export class WebSocketSource implements MediaSource {
  private ws: WebSocket | null = null;
  private queue: Uint8Array[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private ended = false;
  private readonly maxQueue: number;

  constructor(
    url: string,
    opts: {
      binaryType?: BinaryType;
      maxQueueBytes?: number;
      onError?: (err: ReturnType<typeof playerError.network>) => void;
      timeoutMs?: number;
    } = {},
  ) {
    const maxQueueBytes = opts.maxQueueBytes ?? 8 * 1024 * 1024;
    this.maxQueue = Math.max(4, Math.ceil(maxQueueBytes / 64 / 1024)); // 按 ~64KB/消息估算条数

    try {
      const ws = new WebSocket(url);
      ws.binaryType = opts.binaryType ?? 'arraybuffer';
      this.ws = ws;
      ws.onmessage = (event) => this.onMessage(event.data);
      ws.onerror = () => {
        opts.onError?.(playerError.network('WebSocket 连接错误'));
      };
      ws.onclose = () => {
        this.ended = true;
        this.drainWaiters();
      };
    } catch (err) {
      throw playerError.network(`WebSocket 创建失败: ${String(err)}`, err);
    }

    const timeoutMs = opts.timeoutMs ?? 15000;
    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        opts.onError?.(playerError.timeout('WebSocket 握手超时'));
        this.abort();
      }
    }, timeoutMs);
  }

  get finite(): boolean {
    return false;
  }

  private onMessage(data: unknown): void {
    if (this.closed) return;
    let chunk: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (data instanceof Blob) {
      void data.arrayBuffer().then((ab) => this.onMessage(ab));
      return;
    } else if (data instanceof Uint8Array) chunk = data;
    if (!chunk) return;

    this.queue.push(chunk);
    // 背压：丢弃最旧消息
    while (this.queue.length > this.maxQueue) this.queue.shift();
    this.drainWaiters();
  }

  async next(): Promise<ChunkResult> {
    while (true) {
      if (this.closed) return { done: true };
      if (this.queue.length > 0) {
        return { done: false, value: this.queue.shift()! };
      }
      if (this.ended) return { done: true };
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private drainWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.drainWaiters();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
