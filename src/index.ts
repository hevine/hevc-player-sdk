/**
 * @waiyubaodian/hevc-player —— 框架无关的 H.265/HEVC 播放器 SDK
 * ------------------------------------------------------------------
 * 纯 WASM 软解（libde265），支持点播（MP4/Annex-B）与实时流
 * （HTTP-FLV / WS-FLV / WS-AnnexB）。对外只暴露 H265Player 主类、
 * 类型与错误体系；React 封装在 '@waiyubaodian/hevc-player/react' 子路径。
 */
export { H265Player } from './H265Player';
export { MediaPlayer } from './MediaPlayer';
export { AudioPlayer } from './audio/AudioPlayer';
export { detectMediaType, looksLikeAudio } from './media-type';
export { PlayerError, playerError } from './errors';
export type {
  PlayerOptions,
  PlayerState,
  PlayerEvents,
  PlayerStats,
  PlayerErrorInfo,
  MediaInfo,
  LoadOptions,
  SourceKind,
  ContainerFormat,
  DecodeBackend,
  DropPolicy,
  RendererKind,
  LogLevel,
  LoggerLike,
  VideoFrameData,
  EventHandler,
  ErrorCode,
  MediaType,
  MediaTypeHint,
  MediaPlayerOptions,
  MediaLoadOptions,
  AudioVisualOptions,
} from './types';
