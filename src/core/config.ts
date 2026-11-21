import type { PlayerOptions, SourceKind, ContainerFormat, DropPolicy } from '../types';
import { playerError } from '../errors';

/** 校验通过后的规范化配置（所有字段都有确定值） */
export interface ResolvedConfig {
  canvas: HTMLCanvasElement;
  sourceKind: SourceKind;
  container?: ContainerFormat;
  ignoreAudio: boolean;
  backend: 'wasm';
  renderer: 'canvas2d' | 'webgl2' | 'auto';
  dropPolicy: DropPolicy;
  maxBufferedFrames: number;
  lowLatency: boolean;
  logLevel: NonNullable<PlayerOptions['logLevel']>;
  logger?: PlayerOptions['logger'];
  wsBinaryType: BinaryType;
  headers: Record<string, string>;
  timeoutMs: number;
}

/** 集中校验配置，启动时快速失败 */
export function resolveConfig(opts: PlayerOptions): ResolvedConfig {
  if (!opts || !opts.canvas) {
    throw playerError.invalidOption('必须提供 canvas 元素');
  }
  // SSR / 非浏览器环境的友好报错（必须先检查定义，否则 instanceof 抛 ReferenceError）
  if (typeof HTMLCanvasElement === 'undefined') {
    throw playerError.unsupported('H265Player 只能在浏览器环境运行');
  }
  if (!(opts.canvas instanceof HTMLCanvasElement)) {
    throw playerError.invalidOption('canvas 必须是 HTMLCanvasElement');
  }
  if (opts.maxBufferedFrames !== undefined && (opts.maxBufferedFrames < 1 || opts.maxBufferedFrames > 600)) {
    throw playerError.invalidOption('maxBufferedFrames 必须在 1~600 之间');
  }
  if (opts.timeoutMs !== undefined && opts.timeoutMs < 500) {
    throw playerError.invalidOption('timeoutMs 不得小于 500');
  }
  const sourceKind = opts.sourceKind ?? 'url';
  const dropPolicy: DropPolicy =
    opts.dropPolicy ?? (isLiveKind(sourceKind) ? 'realtime' : 'all');

  return {
    canvas: opts.canvas,
    sourceKind,
    container: opts.container,
    ignoreAudio: opts.ignoreAudio ?? false,
    backend: 'wasm',
    renderer: opts.renderer ?? 'canvas2d',
    dropPolicy,
    maxBufferedFrames: opts.maxBufferedFrames ?? 30,
    lowLatency: opts.lowLatency ?? false,
    logLevel: opts.logLevel ?? 'warn',
    logger: opts.logger,
    wsBinaryType: opts.wsBinaryType ?? 'arraybuffer',
    headers: opts.headers ?? {},
    timeoutMs: opts.timeoutMs ?? 15000,
  };
}

function isLiveKind(kind: SourceKind): boolean {
  return kind === 'ws-flv' || kind === 'ws-raw';
}

/** 根据 sourceKind / URL / Content-Type 推断容器格式 */
export function detectContainer(
  kind: SourceKind,
  url: string,
  contentType?: string,
  explicit?: ContainerFormat,
): ContainerFormat {
  if (explicit) return explicit;
  if (kind === 'mp4' || kind === 'raw' || kind === 'flv') {
    return kind === 'mp4' ? 'mp4' : kind === 'raw' ? 'annexb' : 'flv';
  }
  const cleanUrl = url.split('?')[0]!.toLowerCase();
  if (cleanUrl.endsWith('.flv') || cleanUrl.includes('.flv')) return 'flv';
  if (cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.m4v') || cleanUrl.endsWith('.mov')) return 'mp4';
  if (cleanUrl.endsWith('.h265') || cleanUrl.endsWith('.hevc') || cleanUrl.endsWith('.265')) return 'annexb';
  if (contentType) {
    if (/flv|video\/x-flv/i.test(contentType)) return 'flv';
    if (/mp4/i.test(contentType)) return 'mp4';
  }
  // 默认按裸流处理（ws-raw / 未知）
  return 'annexb';
}
