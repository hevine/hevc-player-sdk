import { H265Player } from './H265Player';
import { AudioPlayer } from './audio/AudioPlayer';
import { detectMediaType } from './media-type';
import { playerError, PlayerError } from './errors';
import { Logger } from './core/logger';
import { EventEmitter } from './core/event-emitter';
import type {
  EventHandler,
  LoadOptions,
  MediaInfo,
  MediaLoadOptions,
  MediaPlayerOptions,
  MediaType,
  PlayerErrorInfo,
  PlayerEvents,
  PlayerState,
  PlayerStats,
} from './types';

type Backend = H265Player | AudioPlayer;

/**
 * MediaPlayer —— 统一媒体播放器门面
 * ------------------------------------------------------------------
 * 一套视觉外壳（同一块 canvas），两种后端：
 *   - video → H265Player（WASM 软解 HEVC，画面渲染）
 *   - audio → AudioPlayer（原生播放 + Web Audio 频谱柱 / 呼吸光晕）
 * 自动按显式提示 / sourceKind / URL 后缀 / Blob MIME 探测类型；
 * 类型变化或显式切换时，销毁旧后端、重建新后端，事件统一转发。
 * H265Player 的原有 API 全部保留，现有调用方零改动。
 */
export class MediaPlayer {
  private readonly config: MediaPlayerOptions;
  private readonly log: Logger;
  private readonly events = new EventEmitter();
  private backend: Backend | null = null;
  private backendType: MediaType | null = null;
  private volume: number;
  private destroyed = false;
  private offs: Array<() => void> = [];

  constructor(options: MediaPlayerOptions) {
    if (!options?.canvas) throw playerError.invalidOption('必须提供 canvas 元素');
    this.config = options;
    this.log = new Logger(options.logLevel ?? 'warn', options.logger);
    this.volume = Math.max(0, Math.min(1, options.volume ?? 1));
  }

  on<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): () => void {
    return this.events.on(event, handler);
  }
  once<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): () => void {
    return this.events.once(event, handler);
  }
  off<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): void {
    this.events.off(event, handler);
  }

  get state(): PlayerState {
    return this.backend?.state ?? 'idle';
  }
  get info(): MediaInfo | null {
    return this.backend?.info ?? null;
  }
  get mediaType(): MediaType | null {
    return this.backendType;
  }
  get currentBackend(): Backend | null {
    return this.backend;
  }
  get volumeValue(): number {
    return this.backend instanceof AudioPlayer ? this.backend.volume : this.volume;
  }

  getStats(): PlayerStats {
    if (!this.backend) {
      return {
        state: 'idle',
        decodedFrames: 0,
        droppedFrames: 0,
        bufferedFrames: 0,
        lastDecodeMs: 0,
        decodeFps: 0,
        positionUs: 0,
        decodeBackend: this.backendType === 'audio' ? 'native-audio' : 'wasm',
        mediaType: this.backendType ?? undefined,
        volume: this.volume,
      };
    }
    const s = this.backend.getStats();
    return { ...s, mediaType: this.backendType ?? s.mediaType, volume: this.volumeValue };
  }

  /** 加载媒体；opts.mediaType 可显式指定 'audio' / 'video' / 'auto' */
  async load(options: MediaLoadOptions): Promise<void> {
    this.ensureAlive();
    const sourceKind = options.sourceKind ?? this.config.sourceKind;
    const urlForDetect = typeof options.url === 'string' ? options.url : '';
    const blobMime = options.url instanceof Blob ? options.url.type : undefined;
    const type = detectMediaType(
      options.url,
      sourceKind,
      blobMime,
      options.mediaType ?? this.config.mediaType,
    );

    if (this.backend && this.backendType !== type) {
      await this.destroyBackend();
      this.backendType = null;
    }
    if (!this.backend) {
      this.backendType = type;
      this.backend = this.createBackend(type);
      this.bindBackend(this.backend);
    }

    const loadOpts: LoadOptions = {
      url: options.url,
      sourceKind: options.sourceKind,
      container: options.container,
      startUs: options.startUs,
    };
    await this.backend.load(loadOpts);
    // 注入标题（若有）
    if (options.title && this.backend.info) this.backend.info.title = options.title;
    this.log.info('media load', { type, url: urlForDetect || '(blob)' });
  }

  play(): void {
    this.ensureAlive();
    if (!this.backend) throw playerError.state('请先 load() 再 play()');
    this.backend.play();
  }
  pause(): void {
    this.backend?.pause();
  }
  stop(): void {
    this.backend?.stop();
  }
  async seek(us: number): Promise<void> {
    if (!this.backend) throw playerError.state('请先 load() 再 seek()');
    await this.backend.seek(us);
  }
  setRate(rate: number): void {
    this.backend?.setRate(rate);
  }
  /** 音量（两种媒体通用；视频后端记录值以供切换后恢复） */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.backend instanceof AudioPlayer) this.backend.setVolume(this.volume);
    this.events.emit('volumechange', { volume: this.volume, muted: false });
  }
  setMuted(muted: boolean): void {
    if (this.backend instanceof AudioPlayer) this.backend.setMuted(muted);
    this.events.emit('volumechange', { volume: this.volume, muted });
  }
  /** 仅音频后端有效：最近一帧频谱数据 */
  getSpectrum(): Uint8Array | null {
    return this.backend instanceof AudioPlayer ? this.backend.getSpectrum() : null;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.destroyBackend();
    this.events.clear();
  }

  // ---------- 内部 ----------
  private createBackend(type: MediaType): Backend {
    const canvas = this.config.canvas;
    if (type === 'audio') {
      return new AudioPlayer({
        canvas,
        visual: this.config.audio,
        volume: this.volume,
        crossOrigin: this.config.audioCrossOrigin,
        logLevel: this.config.logLevel,
        logger: this.config.logger,
        timeoutMs: this.config.timeoutMs,
      });
    }
    return new H265Player({
      canvas,
      sourceKind: this.config.sourceKind,
      container: this.config.container,
      ignoreAudio: this.config.ignoreAudio,
      backend: this.config.backend,
      renderer: this.config.renderer,
      dropPolicy: this.config.dropPolicy,
      maxBufferedFrames: this.config.maxBufferedFrames,
      lowLatency: this.config.lowLatency,
      logLevel: this.config.logLevel,
      logger: this.config.logger,
      wsBinaryType: this.config.wsBinaryType,
      headers: this.config.headers,
      timeoutMs: this.config.timeoutMs,
    });
  }

  private bindBackend(backend: Backend): void {
    this.offs.forEach((off) => off());
    this.offs = [
      backend.on('statechange', (p) => this.events.emit('statechange', p)),
      backend.on('ready', (p) => this.events.emit('ready', p)),
      backend.on('frame', (p) => this.events.emit('frame', p)),
      backend.on('error', (p) => this.events.emit('error', p)),
      backend.on('ended', (p) => this.events.emit('ended', p)),
      backend.on('buffering', (p) => this.events.emit('buffering', p)),
      backend.on('progress', (p) => this.events.emit('progress', p)),
    ];
  }

  private async destroyBackend(): Promise<void> {
    this.offs.forEach((off) => off());
    this.offs = [];
    if (this.backend instanceof AudioPlayer) {
      await this.backend.destroy();
    } else if (this.backend) {
      await this.backend.destroy();
    }
    this.backend = null;
  }

  private ensureAlive(): void {
    if (this.destroyed) throw playerError.state('播放器已销毁');
  }
}

// 供类型收窄使用
export type { PlayerErrorInfo };
