import type {
  PlayerOptions,
  PlayerState,
  LoadOptions,
  MediaInfo,
  PlayerStats,
  VideoFrameData,
  EventHandler,
  PlayerEvents,
} from './types';
import { playerError, PlayerError } from './errors';
import { Logger } from './core/logger';
import { EventEmitter } from './core/event-emitter';
import { StateMachine } from './core/state-machine';
import { resolveConfig, detectContainer, type ResolvedConfig } from './core/config';
import { WasmDecoder } from './decoder/wasm-decoder';
import { Canvas2DRenderer, type Renderer } from './render/canvas2d';
import { Clock } from './av/clock';
import { HttpSource } from './source/http';
import { WebSocketSource } from './source/websocket';
import { FileSource } from './source/file';
import type { MediaSource } from './source/types';
import { AnnexBSplitter } from './demux/annex-b';
import { FlvDemuxer } from './demux/flv';
import { Mp4Demuxer } from './demux/mp4';
import type { Demuxer, DemuxSink } from './demux/types';

/**
 * H265Player —— 播放器主控（控制器）
 * ------------------------------------------------------------------
 * 职责：编排数据源→解封装→解码→渲染，维护状态机与事件，做背压与帧调度。
 * 不产生业务逻辑之外的副作用；所有错误归一化为 PlayerError 并经 error 事件广播。
 * 每个 load() 使用 sessionId，旧会话的异步回调全部失效，杜绝跨实例串台。
 */
export class H265Player {
  private readonly config: ResolvedConfig;
  private readonly log: Logger;
  private readonly events = new EventEmitter();
  private readonly sm: StateMachine;
  private readonly clock = new Clock();
  private decoder: WasmDecoder | null = null;
  private renderer: Renderer | null = null;
  private source: MediaSource | null = null;
  private demuxer: Demuxer | null = null;

  private sessionId = 0;
  private pumpAbort: (() => void) | null = null;
  private frameQueue: VideoFrameData[] = [];
  /** demux 产出但尚未提交解码的 access unit 队列（点播节流用） */
  private pendingUnits: Array<{ nals: Uint8Array[]; ptsUs: number; key: boolean }> = [];
  private rafId: number | null = null;
  private renderPumpRunning = false;

  private mediaInfo: MediaInfo | null = null;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private lastDecodeMs = 0;
  private decodeFpsWindow: number[] = [];
  private destroyed = false;

  constructor(options: PlayerOptions) {
    this.config = resolveConfig(options);
    this.log = new Logger(this.config.logLevel, this.config.logger);
    this.sm = new StateMachine((from, to) => {
      this.events.emit('statechange', { from, to });
      this.log.debug('state', { from, to });
    });
    this.renderer = new Canvas2DRenderer(this.config.canvas);
  }

  // ---------- 公共：事件 ----------
  on<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): () => void {
    return this.events.on(event, handler);
  }
  once<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): () => void {
    return this.events.once(event, handler);
  }
  off<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): void {
    this.events.off(event, handler);
  }

  // ---------- 公共：状态与统计 ----------
  get state(): PlayerState {
    return this.sm.state;
  }
  get info(): MediaInfo | null {
    return this.mediaInfo;
  }
  getStats(): PlayerStats {
    const avgFps = this.decodeFpsWindow.length
      ? this.decodeFpsWindow.reduce((a, b) => a + b, 0) / this.decodeFpsWindow.length
      : 0;
    return {
      state: this.sm.state,
      decodedFrames: this.decodedFrames,
      droppedFrames: this.droppedFrames,
      bufferedFrames: this.frameQueue.length,
      lastDecodeMs: this.lastDecodeMs,
      decodeFps: Math.round(avgFps * 10) / 10,
      positionUs: this.clock.nowUs(),
      decodeBackend: 'wasm',
    };
  }

  // ---------- 公共：生命周期 ----------
  /** 加载并自动播放媒体 */
  async load(options: LoadOptions): Promise<void> {
    this.ensureAlive();
    this.stopInternal(false); // 停掉旧会话但不改 idle
    const session = ++this.sessionId; // stopInternal 已自增，之后取新 session

    try {
      this.sm.transition('loading');

      const sourceKind = options.sourceKind ?? this.config.sourceKind;
      const source = this.createSource(options.url, sourceKind, session);
      this.source = source;

      // 推断容器（Blob 源无 URL 后缀，依赖显式 container 或默认裸流）
      const urlForDetect = typeof options.url === 'string' ? options.url : '';
      const container = detectContainer(
        sourceKind,
        urlForDetect,
        source.contentType,
        options.container ?? this.config.container,
      );
      this.log.info('load', { url: urlForDetect || '(blob)', sourceKind, container });

      // 创建解码器（幂等）
      if (!this.decoder) {
        this.decoder = new WasmDecoder(
          {
            onReady: () => undefined,
            onFrame: (frame) => this.onDecodedFrame(session, frame),
            onError: (err) => this.handleError(err, session),
          },
          this.log,
          Math.max(4, Math.floor(this.config.maxBufferedFrames / 3)), // 在途解码上限，配合节流平滑帧队列
        );
      }
      await this.decoder.init();
      if (session !== this.sessionId) return;

      // 等待 ready 的 Promise（MP4 元数据在 pump 异步解析后才就绪）
      let signalReady: () => void = () => undefined;
      const readyPromise = new Promise<void>((resolve) => {
        signalReady = resolve;
      });

      // 创建 demuxer
      const sink: DemuxSink = {
        onUnit: (unit) => {
          if (session !== this.sessionId) return;
          // 不在这里直接解码：放入待解码队列，由 pump 按渲染进度节流提交
          this.pendingUnits.push({ nals: unit.nals, ptsUs: unit.ptsUs, key: unit.key });
        },
        onTrackInfo: (info) => {
          if (session !== this.sessionId) return;
          this.mediaInfo = {
            width: info.width,
            height: info.height,
            pixelFormat: 'yuv420p',
            fps: info.fps,
            durationUs: info.durationUs,
            seekable: this.demuxer?.seekable ?? false,
            hasAudio: false,
          };
          this.renderer?.resize(info.width, info.height);
          if (this.sm.state === 'loading') this.sm.transition('ready');
          this.events.emit('ready', this.mediaInfo);
          signalReady();
        },
        onAudio: () => undefined, // v0.1 音频 best-effort，暂不解码
      };
      this.demuxer = this.createDemuxer(container, sink, session);

      // 启动渲染泵
      this.startRenderPump(session);

      // 启动数据拉取 pump（异步，不阻塞 load 返回）
      void this.runPump(session, source, sourceKind, options.startUs);

      // 直播流不会来 onTrackInfo（无 moov），进入 ready 用第一帧尺寸
      if (!source.finite || container === 'annexb' || container === 'flv') {
        if (this.sm.state === 'loading') {
          this.sm.transition('ready');
          this.events.emit('ready', {
            width: 0,
            height: 0,
            durationUs: 0,
            seekable: false,
            hasAudio: false,
          });
          signalReady();
        }
      }
      this.clock.start(options.startUs ?? 0);

      // 等待元数据就绪（最多 timeoutMs），保证 load() 返回后调用方可以安全 play()
      await Promise.race([
        readyPromise,
        new Promise<void>((resolve) => setTimeout(resolve, this.config.timeoutMs)),
      ]);
    } catch (err) {
      const pe = err instanceof PlayerError ? err : playerError.decode(String(err));
      this.handleError(pe, session);
      throw pe;
    }
  }

  /** 开始/恢复播放 */
  play(): void {
    this.ensureAlive();
    if (this.sm.is('playing')) return;
    if (this.sm.is('idle') || this.sm.is('error')) {
      throw playerError.state('请先 load() 再 play()');
    }
    if (this.sm.is('ended')) {
      this.sm.transition('ready');
    }
    // loading 状态下提前 play()：先转 ready（元数据到达后 onTrackInfo 不会重复转）
    if (this.sm.is('loading')) {
      this.sm.transition('ready');
    }
    this.sm.transition('playing');
    this.clock.resume();
  }

  /** 暂停（保留帧队列与位置） */
  pause(): void {
    if (!this.sm.is('playing') && !this.sm.is('seeking')) return;
    this.sm.transition('paused');
    this.clock.pause();
  }

  /** 停止：清空队列、中止数据源、解码器复位，回到 idle */
  stop(): void {
    this.stopInternal(true);
  }

  /** seek 到指定微秒（仅点播可 seek 源） */
  async seek(us: number): Promise<void> {
    this.ensureAlive();
    if (!this.demuxer?.seekable || !this.demuxer.seek) {
      throw playerError.state('当前媒体不支持 seek');
    }
    const wasPlaying = this.sm.is('playing');
    this.sm.transition('seeking');
    this.frameQueue = [];
    this.decoder?.reset();
    this.demuxer.seek(us);
    this.clock.seek(us);
    this.sm.transition(wasPlaying ? 'playing' : 'paused');
  }

  /** 倍速 */
  setRate(rate: number): void {
    this.clock.setRate(rate);
  }

  /** 彻底销毁：释放所有资源，之后不可再用 */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopInternal(true);
    if (this.decoder) await this.decoder.destroy();
    this.decoder = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.events.clear();
    this.log.info('destroyed');
  }

  // ---------- 内部：数据泵 ----------
  private createSource(url: string | Blob, kind: string, session: number): MediaSource {
    if (typeof Blob !== 'undefined' && url instanceof Blob) {
      return new FileSource(url);
    }
    const urlStr = url as string;
    if (kind === 'ws-flv' || kind === 'ws-raw') {
      return new WebSocketSource(urlStr, {
        binaryType: this.config.wsBinaryType,
        onError: (err) => this.handleError(err, session),
        timeoutMs: this.config.timeoutMs,
      });
    }
    return new HttpSource(urlStr, { headers: this.config.headers, timeoutMs: this.config.timeoutMs });
  }

  private createDemuxer(container: string, sink: DemuxSink, _session: number): Demuxer {
    switch (container) {
      case 'mp4':
        return new Mp4Demuxer(sink);
      case 'flv':
        return new FlvDemuxer(sink);
      case 'annexb':
      default:
        return new AnnexBSplitter(sink, this.mediaInfo?.fps ?? 25);
    }
  }

  private async runPump(session: number, source: MediaSource, kind: string, startUs?: number): Promise<void> {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
    };
    this.pumpAbort = onAbort;

    try {
      // MP4 seek 起点：通过 Range 请求头部字节
      if (startUs && kind !== 'ws-flv' && kind !== 'ws-raw' && source.readRange) {
        // v0.1：seek 由独立 seek() API 处理，此处仅重置位置
        void startUs;
      }
      const finite = source.finite;
      while (!aborted && session === this.sessionId) {
        await this.decoder?.awaitDrain();
        if (aborted || session !== this.sessionId) break;
        const { done, value } = await source.next();
        if (done || !value) break;
        if (aborted || session !== this.sessionId) break;
        this.demuxer?.push(value);

        // 按渲染进度节流地把 demux 出的单元提交解码：
        // 点播等帧队列消化到阈值以下；直播立即提交（低延迟优先）。
        let guard = 0;
        while (this.pendingUnits.length > 0 && session === this.sessionId && !aborted) {
          await this.decoder?.awaitDrain();
          if (finite) await this.awaitFrameRoom(session, () => aborted);
          if (aborted || session !== this.sessionId) break;
          const unit = this.pendingUnits.shift()!;
          const t0 = performance.now();
          this.decoder?.decode(unit.nals, unit.ptsUs, unit.key);
          this.lastDecodeMs = performance.now() - t0;
          if (guard++ > 10000) break; // 安全阀
        }
      }
      if (!aborted && session === this.sessionId) {
        this.demuxer?.flush();
        // 冲刷剩余待解码单元
        while (this.pendingUnits.length > 0) {
          const unit = this.pendingUnits.shift()!;
          const t0 = performance.now();
          this.decoder?.decode(unit.nals, unit.ptsUs, unit.key);
          this.lastDecodeMs = performance.now() - t0;
        }
        this.decoder?.flush();
        if (this.sm.is('playing') || this.sm.is('paused')) {
          this.sm.transition('ended');
          this.events.emit('ended', undefined);
        }
      }
    } catch (err) {
      if (aborted || session !== this.sessionId) return;
      this.handleError(err instanceof PlayerError ? err : playerError.network(String(err)), session);
    } finally {
      if (this.pumpAbort === onAbort) this.pumpAbort = null;
    }
  }

  /** 点播节流：帧队列积压时等待渲染消费，避免无谓丢帧。直播不调用。 */
  private async awaitFrameRoom(session: number, isAborted: () => boolean): Promise<void> {
    const threshold = Math.max(4, Math.floor(this.config.maxBufferedFrames / 3));
    let guard = 0;
    while (
      this.frameQueue.length >= threshold &&
      session === this.sessionId &&
      !isAborted() &&
      !this.sm.is('idle') &&
      guard++ < 600
    ) {
      await new Promise<void>((r) => setTimeout(r, 16));
    }
  }

  // ---------- 内部：帧调度与渲染 ----------
  private onDecodedFrame(session: number, frame: VideoFrameData): void {
    if (session !== this.sessionId || this.destroyed) return;
    this.decodedFrames = Math.min(this.decodedFrames + 1, Number.MAX_SAFE_INTEGER);

    // 首帧确定尺寸（直播 / 裸流无 onTrackInfo 时）
    if (!this.mediaInfo || (this.mediaInfo.width === 0 && frame.width > 0)) {
      this.mediaInfo = {
        width: frame.width,
        height: frame.height,
        pixelFormat: 'yuv420p',
        durationUs: 0,
        seekable: false,
        hasAudio: false,
      };
      this.renderer?.resize(frame.width, frame.height);
      if (this.sm.state === 'loading' || (this.sm.state === 'ready' && this.mediaInfo.width > 0)) {
        this.events.emit('ready', this.mediaInfo);
      }
    }

    this.decodeFpsWindow.push(60);
    if (this.decodeFpsWindow.length > 30) this.decodeFpsWindow.shift();

    this.frameQueue.push(frame);

    // 缓冲超限：按策略丢帧
    while (this.frameQueue.length > this.config.maxBufferedFrames) {
      if (this.config.dropPolicy === 'realtime' || this.config.lowLatency) {
        this.frameQueue.shift();
        this.droppedFrames++;
      } else {
        this.frameQueue.shift();
        this.droppedFrames++;
      }
    }
    this.events.emit('buffering', {
      level: this.frameQueue.length / this.config.maxBufferedFrames,
      bufferedFrames: this.frameQueue.length,
    });
  }

  private startRenderPump(session: number): void {
    if (this.renderPumpRunning) return;
    this.renderPumpRunning = true;
    const tick = () => {
      if (session !== this.sessionId || this.destroyed || !this.renderPumpRunning) {
        this.renderPumpRunning = false;
        return;
      }
      this.renderStep();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private renderStep(): void {
    if (this.sm.is('paused') || this.sm.is('idle') || this.sm.is('loading')) return;
    if (this.frameQueue.length === 0) return;

    const nowUs = this.clock.nowUs();
    const live = this.config.lowLatency || this.config.dropPolicy === 'realtime';

    // 直播/低延迟：直接渲染最新帧，丢弃过期帧
    if (live) {
      let frame: VideoFrameData | undefined;
      while (this.frameQueue.length > 1) {
        const head = this.frameQueue[0]!;
        if (head.ptsUs < nowUs - 80_000) {
          this.frameQueue.shift();
          this.droppedFrames++;
        } else break;
      }
      frame = this.frameQueue.shift();
      if (frame) this.drawFrame(frame);
      return;
    }

    // 点播：按 pts 对齐时钟
    const head = this.frameQueue[0]!;
    if (head.ptsUs <= nowUs + 16_000) {
      this.frameQueue.shift();
      this.drawFrame(head);
    }
  }

  private drawFrame(frame: VideoFrameData): void {
    try {
      this.renderer?.render(frame);
      this.events.emit('frame', {
        ptsUs: frame.ptsUs,
        width: frame.width,
        height: frame.height,
      });
    } catch (err) {
      this.handleError(playerError.render(String(err)), this.sessionId);
    }
  }

  // ---------- 内部：错误处理与清理 ----------
  private handleError(err: PlayerError, session: number): void {
    if (session !== this.sessionId) return;
    if (err.isAbort) return;
    this.log.error('player error', { code: err.code, message: err.message });
    if (!this.sm.is('error')) this.sm.transition('error', true);
    this.events.emit('error', err);
  }

  private stopInternal(backToIdle: boolean): void {
    this.sessionId++;
    if (this.pumpAbort) {
      this.pumpAbort();
      this.pumpAbort = null;
    }
    this.source?.abort();
    this.source = null;
    if (this.demuxer instanceof Mp4Demuxer) this.demuxer.destroy();
    this.demuxer = null;
    this.decoder?.reset();
    this.frameQueue = [];
    this.pendingUnits = [];
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.renderPumpRunning = false;
    this.mediaInfo = null;
    if (backToIdle && !this.sm.is('idle') && !this.destroyed) {
      this.sm.transition('idle', true);
    }
  }

  private ensureAlive(): void {
    if (this.destroyed) throw playerError.state('播放器已销毁');
  }
}
