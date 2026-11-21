import type { MediaType, MediaTypeHint, SourceKind } from './types';

/**
 * 媒体类型探测
 * ------------------------------------------------------------------
 * 优先级：显式提示 > sourceKind > Blob MIME > URL 路径后缀 > Content-Type。
 * 默认返回 'video'（本 SDK 的核心能力是 H.265 视频，避免误判导致软解路径失效）。
 */

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|weba|aiff?|caf)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|flv|h265|hevc|265|ts|webm|mkv|avi)$/i;
const VIDEO_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  'mp4',
  'flv',
  'raw',
  'ws-flv',
  'ws-raw',
]);

export function detectMediaType(
  url: string | Blob,
  sourceKind?: SourceKind,
  mimeType?: string,
  hint?: MediaTypeHint,
): MediaType {
  if (hint === 'video' || hint === 'audio') return hint;

  if (typeof Blob !== 'undefined' && url instanceof Blob) {
    const t = (url.type || '').toLowerCase();
    if (t.startsWith('audio/')) return 'audio';
    if (t.startsWith('video/')) return 'video';
  }

  if (sourceKind && VIDEO_KINDS.has(sourceKind)) return 'video';

  if (typeof url === 'string') {
    const clean = url.split(/[?#]/)[0]!.toLowerCase();
    if (AUDIO_EXT.test(clean)) return 'audio';
    if (VIDEO_EXT.test(clean)) return 'video';
    // 带查询参数或裸路径的流地址，尝试整串匹配一次
    const full = url.toLowerCase();
    if (AUDIO_EXT.test(full)) return 'audio';
  }

  const ct = (mimeType || '').toLowerCase();
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';

  return 'video';
}

/** 供 UI 判断扩展名是否像音频（不含 MIME / sourceKind） */
export function looksLikeAudio(url: string): boolean {
  const clean = url.split(/[?#]/)[0]!.toLowerCase();
  return AUDIO_EXT.test(clean);
}
