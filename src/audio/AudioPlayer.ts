import type {
  AudioVisualOptions,
  EventHandler,
  LoadOptions,
  LogLevel,
  LoggerLike,
  MediaInfo,
  PlayerErrorInfo,
  PlayerEvents,
  PlayerState,
  PlayerStats,
} from '../types';
import { playerError, PlayerError } from '../errors';
import { Logger } from '../core/logger';
import { EventEmitter } from '../core/event-emitter';
import { StateMachine } from '../core/state-machine';
import { SpectrumRenderer, type ResolvedVisualOptions, resolveVisualOptions } from '../render/spectrum';

/**
 * AudioPlayer —— 纯音频后端
 * ------------------------------------------------------------------
 * 浏览器原生 <audio> 播放 + Web Audio AnalyserNode 取实时频谱，
 * 由 SpectrumRenderer 把频谱柱与呼吸光晕画到与视频后端相同的 canvas 上。
 * 对外接口与 H265Player 对齐（state/info/getStats/on/load/play/pause/stop/seek/
 * setRate/destroy），额外提供 setVolume/setMuted。
 */

export interface AudioPlayerOptions {
  canvas: HTMLCanvasElement;
  visual?: AudioVisualOptions;
  volume?: number;
  muted?: boolean;
  crossOrigin?: boolean | 'anonymous' | 'use-credentials';
  logLevel?: LogLevel;
  logger?: LoggerLike;
  timeoutMs?: number;
}

type WebAudioCtor = typeof AudioContext;

export class AudioPlayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly log: Logger;
  private readonly events = new EventEmitter();
  private readonly sm: StateMachine;
  private readonly visualOpts: ResolvedVisualOptions;
  private readonly renderer: SpectrumRenderer;
  private readonly timeoutMs: number;
  private readonly crossOrigin?: 'anonymous' | 'use-credentials';

  private readonly audioEl: HTMLAudioElement;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;

  private mediaInfo: MediaInfo | null = null;
  private objectUrl: string | null = null;
  private sessionId = 0;
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private energy = 0;
  private frames = 0;
  private fpsWindow: number[] = [];
  private destroyed = false;

  constructor(options: AudioPlayerOptions) {
    if (typeof HTMLCanvasElement !== 'undefined' && !(options.canvas instanceof HTMLCanvasElement)) {
      throw playerError.invalidOption('canvas 必须是 HTMLCanvasElement');
    }
    this.canvas = options.canvas;
    this.log = new Logger(options.logLevel ?? 'warn', options.logger);
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.visualOpts = resolveVisualOptions(options.visual);
    this.renderer = new SpectrumRenderer(options.canvas, options.visual);
    this.sm = new StateMachine((from, to) => {
      this.events.emit('statechange', { from, to });
      this.log.debug('audio state', { from, to });
    });

    if (options.crossOrigin === 'use-credentials') this.crossOrigin = 'use-credentials';
    else if (options.crossOrigin) this.crossOrigin = 'anonymous';

    this.audioEl = document.createElement('audio');
    this.audioEl.preload = 'auto';
    if (this.crossOrigin) this.audioEl.crossOrigin = this.crossOrigin;
    if (options.muted) this.audioEl.muted = true;
    this.setVolume(options.volume ?? 1);
    this.bindAudioEvents();
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
  get volume(): number {
    return this.audioEl.volume;
  }
  get muted(): boolean {
    return this.audioEl.muted;
  }

  getStats(): PlayerStats {
    const avgFps = this.fpsWindow.length
      ? this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length
      : 0;
    return {
      state: this.sm.state,
      decodedFrames: this.frames,
      droppedFrames: 0,
      bufferedFrames: 0,
      lastDecodeMs: 0,
      decodeFps: Math.round(avgFps * 10) / 10,
      positionUs: Math.round(this.audioEl.currentTime * 1_000_000),
      decodeBackend: this.analyser ? 'native-audio' : 'native-audio-fallback',
      mediaType: 'audio',
      volume: this.audioEl.volume,
      energy: Math.round(this.energy * 1000) / 1000,
    };
  }

  /** 供宿主自定义可视化：最近一帧的频谱数据（窄带字节数组） */
  getSpectrum(): Uint8Array | null {
    return this.freqData;
  }

  // ---------- 公共：生命周期 ----------
  async load(options: LoadOptions): Promise<void> {
    this.ensureAlive();
    this.stopInternal(false);
    const session = ++this.sessionId;
    try {
      this.sm.transition('loading');
      this.releaseObjectUrl();
      const src = this.toSrc(options.url);
      this.audioEl.src = src;
      this.audioEl.load();

      await this.waitReady(session);
      if (session !== this.sessionId) return;

      const durationUs = Number.isFinite(this.audioEl.duration)
        ? Math.round(this.audioEl.duration * 1_000_000)
        : 0;
      this.mediaInfo = {
        mediaType: 'audio',
        width: 0,
        height: 0,
        durationUs,
        seekable: true,
        hasAudio: true,
      };
      this.renderer.ensureSize();
      // 首帧：画一个静态底图，加载后即有视觉反馈
      this.drawFrame(performance.now());
      if (this.sm.state === 'loading') this.sm.transition('ready');
      this.events.emit('ready', this.mediaInfo);
      this.log.info('audio load', { durationUs, src: typeof options.url === 'string' ? options.url : '(blob)' });
    } catch (err) {
      const pe = err instanceof PlayerError ? err : playerError.demux(String(err));
      this.handleError(pe, session);
      throw pe;
    }
  }

  play(): void {
    this.ensureAlive();
    if (this.sm.is('playing')) return;
    if (this.sm.is('idle') || this.sm.is('error')) {
      throw playerError.state('请先 load() 再 play()');
    }
    if (this.sm.is('ended')) {
      this.audioEl.currentTime = 0;
      this.sm.transition('ready');
    }
    if (this.sm.is('loading')) this.sm.transition('ready');

    this.ensureAudioGraph();
    void this.audioCtx?.resume().catch(() => undefined);

    const p = this.audioEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err: unknown) => {
        // 自动播放被浏览器拦截时给出可恢复提示（通常由用户手势重试）
        this.handleError(playerError.decode(`音频播放被浏览器拦截或失败: ${String(err)}`), this.sessionId);
      });
    }
    this.sm.transition('playing');
    this.startPump();
  }

  pause(): void {
    if (!this.sm.is('playing') && !this.sm.is('seeking')) return;
    this.audioEl.pause();
    this.sm.transition('paused');
  }

  stop(): void {
    this.stopInternal(true);
  }

  async seek(us: number): Promise<void> {
    this.ensureAlive();
    if (!this.mediaInfo?.seekable) throw playerError.state('当前媒体不支持 seek');
    const wasPlaying = this.sm.is('playing');
    if (wasPlaying || this.sm.is('playing')) this.sm.transition('seeking');
    const dur = Number.isFinite(this.audioEl.duration) ? this.audioEl.duration : 0;
    this.audioEl.currentTime = Math.max(0, Math.min(dur, us / 1_000_000));
    this.sm.transition(wasPlaying ? 'playing' : 'paused');
  }

  setRate(rate: number): void {
    const r = Math.max(0.25, Math.min(4, rate));
    this.audioEl.playbackRate = r;
  }

  setVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume));
    this.audioEl.volume = v;
    if (this.gainNode) this.gainNode.gain.value = v;
    this.events.emit('volumechange', { volume: v, muted: this.audioEl.muted });
  }

  setMuted(muted: boolean): void {
    this.audioEl.muted = muted;
    this.events.emit('volumechange', { volume: this.audioEl.volume, muted });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopInternal(true);
    this.audioEl.pause();
    this.audioEl.removeAttribute('src');
    this.audioEl.load();
    this.sourceNode?.disconnect();
    this.analyser?.disconnect();
    this.gainNode?.disconnect();
    this.sourceNode = null;
    this.analyser = null;
    this.gainNode = null;
    this.freqData = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.renderer.destroy();
    this.events.clear();
    this.log.info('audio destroyed');
  }

  // ---------- 内部：Web Audio ----------
  private ensureAudioGraph(): void {
    if (this.audioCtx) return;
    const Ctor: WebAudioCtor | undefined =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as unknown as { webkitAudioContext?: WebAudioCtor }).webkitAudioContext;
    if (!Ctor) {
      this.log.warn('Web Audio 不可用，回退为原生播放（无真实频谱）');
      return;
    }
    try {
      const ctx = new Ctor();
      const source = ctx.createMediaElementSource(this.audioEl);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = this.visualOpts.fftSize;
      analyser.smoothingTimeConstant = this.visualOpts.smoothing;
      const gain = ctx.createGain();
      gain.gain.value = this.audioEl.volume;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      this.audioCtx = ctx;
      this.sourceNode = source;
      this.analyser = analyser;
      this.gainNode = gain;
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      this.log.info('audio graph ready', { fftSize: analyser.fftSize });
    } catch (err) {
      this.log.warn('Web Audio 初始化失败，回退为原生播放', { err: String(err) });
    }
  }

  // ---------- 内部：渲染泵 ----------
  private startPump(): void {
    if (this.rafId !== null) return;
    const tick = (now: number) => {
      if (this.destroyed || !this.sm.is('playing')) {
        this.rafId = null;
        return;
      }
      this.drawFrame(now);
      if (this.lastFrameTime > 0) {
        const dt = now - this.lastFrameTime;
        if (dt > 0) {
          this.fpsWindow.push(1000 / dt);
          if (this.fpsWindow.length > 30) this.fpsWindow.shift();
        }
      }
      this.lastFrameTime = now;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private drawFrame(now: number): void {
    let bands: Uint8Array | null = null;
    if (this.analyser && this.freqData && this.sm.is('playing')) {
      this.analyser.getByteFrequencyData(this.freqData);
      bands = this.freqData;
    } else if (this.freqData && this.sm.is('paused')) {
      // 暂停时保留最后一帧频谱，让视觉自然静止
      bands = this.freqData;
    }
    this.energy = this.renderer.render(bands, null, now);
    this.frames = Math.min(this.frames + 1, Number.MAX_SAFE_INTEGER);
    this.events.emit('frame', { ptsUs: Math.round(this.audioEl.currentTime * 1_000_000), width: 0, height: 0 });
    if (bands) this.events.emit('spectrum', { energy: this.energy, bands });
  }

  // ---------- 内部：事件与工具 ----------
  private bindAudioEvents(): void {
    this.audioEl.addEventListener('ended', () => {
      if (this.destroyed || this.sm.is('idle')) return;
      if (this.sm.is('playing') || this.sm.is('seeking')) this.sm.transition('ended');
      this.events.emit('ended', undefined);
    });
    this.audioEl.addEventListener('error', () => {
      if (this.destroyed || this.sm.is('idle')) return;
      const code = this.audioEl.error?.code;
      this.handleError(
        playerError.network(`音频加载失败 (MediaError ${code ?? 'unknown'})`),
        this.sessionId,
      );
    });
    this.audioEl.addEventListener('waiting', () => {
      this.events.emit('buffering', { level: 0, bufferedFrames: 0 });
    });
    this.audioEl.addEventListener('timeupdate', () => {
      if (!this.mediaInfo) return;
      const d = Number.isFinite(this.audioEl.duration) ? this.audioEl.duration : 0;
      this.events.emit('progress', { bufferedUs: Math.round(this.audioEl.currentTime * 1_000_000), durationUs: Math.round(d * 1_000_000) });
    });
  }

  private async waitReady(session: number): Promise<void> {
    if (this.audioEl.readyState >= 1) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(playerError.timeout('音频元数据加载超时'));
      }, this.timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(playerError.network('音频资源加载失败'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.audioEl.removeEventListener('loadedmetadata', onReady);
        this.audioEl.removeEventListener('error', onErr);
      };
      this.audioEl.addEventListener('loadedmetadata', onReady);
      this.audioEl.addEventListener('error', onErr);
      void session;
    });
  }

  private toSrc(url: string | Blob): string {
    if (typeof Blob !== 'undefined' && url instanceof Blob) {
      this.objectUrl = URL.createObjectURL(url);
      return this.objectUrl;
    }
    return String(url);
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private handleError(err: PlayerError, session: number): void {
    if (session !== this.sessionId || err.isAbort) return;
    this.log.error('audio error', { code: err.code, message: err.message });
    if (!this.sm.is('error')) this.sm.transition('error', true);
    this.events.emit('error', err);
  }

  private stopInternal(backToIdle: boolean): void {
    this.sessionId++;
    this.audioEl.pause();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastFrameTime = 0;
    this.frames = 0;
    this.fpsWindow = [];
    this.energy = 0;
    this.mediaInfo = null;
    if (backToIdle && !this.sm.is('idle') && !this.destroyed) {
      this.sm.transition('idle', true);
    }
  }

  private ensureAlive(): void {
    if (this.destroyed) throw playerError.state('播放器已销毁');
  }
}
