/**
 * 公共类型定义
 * ------------------------------------------------------------------
 * 该文件只描述"对外契约"，不引用任何第三方类型，保持 SDK 核心层
 * 与具体解码器（libde265）、封装库（mp4box）解耦。
 */

/** 播放器生命周期状态 */
export type PlayerState =
  | 'idle' // 未加载任何媒体
  | 'loading' // 正在加载 / 初始化解码器
  | 'ready' // 元数据就绪，可以播放
  | 'playing' // 正在播放
  | 'paused' // 已暂停
  | 'seeking' // 正在跳转
  | 'ended' // 播放结束（点播流）
  | 'error'; // 出错

/** 媒体源类型 */
export type SourceKind =
  | 'url' // HTTP(S) URL，自动按后缀/响应判断 MP4 / FLV / 裸流
  | 'flv' // 明确指定为 FLV（HTTP-FLV 或文件）
  | 'mp4' // 明确指定为 MP4（点播，可 seek）
  | 'raw' // Annex-B H.265 裸流
  | 'ws-flv' // WebSocket 承载的 FLV 流
  | 'ws-raw'; // WebSocket 承载的 Annex-B 裸流

/** 显式容器格式（当用户不想自动探测时指定） */
export type ContainerFormat = 'mp4' | 'flv' | 'annexb';

/**
 * 解码后端。'wasm' 为 H265 软解；'native-audio' 为浏览器原生音频 +
 * Web Audio 频谱分析；'native-audio-fallback' 表示无 Web Audio 时仅原生播放。
 */
export type DecodeBackend = 'wasm' | 'native-audio' | 'native-audio-fallback';

/** 媒体大类：决定使用哪套视觉呈现与后端 */
export type MediaType = 'video' | 'audio';

/** 日志级别 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** 帧投递策略：缓冲积压时的处理原则 */
export type DropPolicy =
  | 'realtime' // 实时优先：积压时丢弃最旧的 P/B 帧，保关键帧（直播默认）
  | 'all' // 完整性优先：不丢帧（离线解码 / 点播默认）
  | 'none'; // 同 'all'，别名，兼容旧配置

/** 渲染器类型 */
export type RendererKind = 'canvas2d' | 'webgl2' | 'auto';

/** 音频可视化视觉选项（仅纯音频模式生效） */
export interface AudioVisualOptions {
  /** 频谱柱数量，默认 64。 */
  barCount?: number;
  /** 频谱柱底部颜色，默认 #4f7cff。 */
  barColor?: string;
  /** 频谱柱顶部颜色，默认 #7fd1ff。 */
  barColorTop?: string;
  /** 呼吸光晕主色，默认 #4f7cff。 */
  haloColor?: string;
  /** 画布背景色，默认 #0b1020。 */
  background?: string;
  /** Web Audio FFT 大小（2 的幂，32~32768），默认 2048。 */
  fftSize?: number;
  /** 频谱平滑系数 0~1，越大越平缓，默认 0.8。 */
  smoothing?: number;
  /** 频谱增益，默认 1.4。 */
  gain?: number;
  /** 是否绘制呼吸光晕，默认 true。 */
  showHalo?: boolean;
  /** 是否绘制频谱柱，默认 true。 */
  showBars?: boolean;
}

/** 媒体类型提示；auto 时按 URL 后缀 / Blob MIME / sourceKind 自动探测 */
export type MediaTypeHint = MediaType | 'auto';

/** 统一媒体播放器配置（在 H265Player 配置基础上增加音频可视化项） */
export interface MediaPlayerOptions extends PlayerOptions {
  /** 默认媒体类型提示。默认 'auto'。 */
  mediaType?: MediaTypeHint;
  /** 音频可视化视觉配置。 */
  audio?: AudioVisualOptions;
  /** 初始音量 0~1，默认 1。 */
  volume?: number;
  /** 跨域音频是否携带 CORS（频谱分析要求资源允许跨域）。默认 false。 */
  audioCrossOrigin?: boolean | 'anonymous' | 'use-credentials';
}

/** 统一媒体播放器加载参数 */
export interface MediaLoadOptions extends LoadOptions {
  /** 覆盖构造时的媒体类型提示。 */
  mediaType?: MediaTypeHint;
  /** 音轨标题（仅用于元数据展示），可选。 */
  title?: string;
}

/** 播放器配置（构造时传入，集中校验） */
export interface PlayerOptions {  /** 渲染目标 canvas。必填。 */
  canvas: HTMLCanvasElement;
  /** 数据源类型。默认 'url'。 */
  sourceKind?: SourceKind;
  /** 显式容器格式；不传则按 sourceKind / URL 后缀自动探测。 */
  container?: ContainerFormat;
  /** 是否忽略音频（纯视频场景可省音轨解码开销）。默认 false。 */
  ignoreAudio?: boolean;
  /** 解码后端，当前仅 'wasm'。默认 'wasm'。 */
  backend?: DecodeBackend;
  /** 渲染器类型。默认 'auto'（优先 canvas2d，稳）。 */
  renderer?: RendererKind;
  /** 帧投递策略。默认按 sourceKind 推断。 */
  dropPolicy?: DropPolicy;
  /** 目标缓冲帧数上限，超过则按 dropPolicy 处理。默认 30。 */
  maxBufferedFrames?: number;
  /** 低延迟模式：减小缓冲、渲染不做额外排队。默认 false。 */
  lowLatency?: boolean;
  /** 日志级别。默认 'warn'。 */
  logLevel?: LogLevel;
  /** 自定义日志器（可选），用于接入宿主日志系统。 */
  logger?: LoggerLike;
  /** WebSocket 二进制类型（'arraybuffer' | 'blob'）。默认 'arraybuffer'。 */
  wsBinaryType?: BinaryType;
  /** HTTP 请求自定义头（如鉴权）。默认 {}。 */
  headers?: Record<string, string>;
  /** 请求/握手超时（毫秒）。默认 15000。 */
  timeoutMs?: number;
}

/** 日志器接口 —— 与宿主系统对接的最小契约 */
export interface LoggerLike {
  trace?(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** 媒体元数据 */
export interface MediaInfo {
  /** 媒体大类；纯音频时 width/height 为 0。 */
  mediaType?: MediaType;
  /** 音轨/媒体标题（可选）。 */
  title?: string;
  width: number;
  height: number;
  /** 像素格式名，如 yuv420p。 */
  pixelFormat?: string;
  /** 帧率（若能从容器读到）。 */
  fps?: number;
  /** 总时长（微秒）；直播流为 0。 */
  durationUs?: number;
  /** 是否可 seek（点播文件为 true，直播为 false）。 */
  seekable: boolean;
  /** 是否含音轨。 */
  hasAudio: boolean;
}

/** 一帧解码后的 YUV 图像（平面数据） */
export interface VideoFrameData {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  width: number;
  height: number;
  /** Y 平面步长。 */
  strideY: number;
  /** U 平面步长。 */
  strideU: number;
  /** V 平面步长。 */
  strideV: number;
  /** 显示时间戳（微秒）。 */
  ptsUs: number;
  /** 是否关键帧。 */
  key?: boolean;
}

/**
 * 错误结构（供事件与 UI 使用）
 * PlayerError 类在结构上满足此接口，避免 types 与 errors 循环依赖。
 */
export interface PlayerErrorInfo {
  readonly name: string;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly isAbort: boolean;
  readonly cause?: unknown;
}

/** 播放器事件映射（供 on/off 使用，带类型） */
export interface PlayerEvents {
  statechange: { from: PlayerState; to: PlayerState };
  ready: MediaInfo;
  frame: { ptsUs: number; width: number; height: number };
  error: PlayerErrorInfo;
  ended: undefined;
  buffering: { level: number; bufferedFrames: number };
  progress: { bufferedUs: number; durationUs: number };
  stats: PlayerStats;
  log: { level: LogLevel; message: string; context?: Record<string, unknown> };
  /** 音量变化（统一播放器） */
  volumechange: { volume: number; muted: boolean };
  /** 频谱能量变化（纯音频后端，约每帧一次；供宿主自定义可视化） */
  spectrum: { energy: number; bands: Uint8Array };
}

/** 运行时统计 */
export interface PlayerStats {
  state: PlayerState;
  decodedFrames: number;
  droppedFrames: number;
  bufferedFrames: number;
  /** 解码耗时（毫秒，最近一帧）。 */
  lastDecodeMs: number;
  /** 平均解码帧率。 */
  decodeFps: number;
  /** 当前播放位置（微秒）。 */
  positionUs: number;
  decodeBackend: DecodeBackend;
  /** 媒体大类（统一播放器提供；H265Player 恒为 video）。 */
  mediaType?: MediaType;
  /** 音量 0~1（纯音频后端有效）。 */
  volume?: number;
  /** 当前音频能量 0~1（用于频谱可视化）。 */
  energy?: number;
}

/** 事件监听回调 */
export type EventHandler<K extends keyof PlayerEvents> = (payload: PlayerEvents[K]) => void;

/** 错误码枚举（稳定字符串，供调用方分支处理） */
export type ErrorCode =
  | 'INVALID_OPTION' // 配置非法
  | 'UNSUPPORTED' // 当前环境不支持（无 WASM / 无 Worker 等）
  | 'NETWORK' // 网络/连接错误
  | 'HTTP_STATUS' // HTTP 非 2xx
  | 'DEMUX' // 解封装错误
  | 'DECODE' // 解码错误
  | 'TIMEOUT' // 超时
  | 'ABORTED' // 被主动中止（stop/destroy 导致，通常不视为故障）
  | 'STATE' // 状态机非法迁移
  | 'RENDER'; // 渲染错误

/** 加载媒体的参数 */
export interface LoadOptions {
  /** 媒体 URL（http/https/ws/wss、blob:/object URL）或 File/Blob 对象。 */
  url: string | Blob;
  /** 覆盖构造时的 sourceKind。 */
  sourceKind?: SourceKind;
  /** 覆盖构造时的 container。 */
  container?: ContainerFormat;
  /** 起始播放位置（微秒），仅点播可 seek 源有效。 */
  startUs?: number;
}
