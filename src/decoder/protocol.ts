/**
 * 主线程 <-> 解码 Worker 的消息协议
 * 只放类型契约，避免 worker 侧引入主线程模块（如 React / DOM）。
 */
import type { VideoFrameData } from '../types';

export type ToWorkerMessage =
  | { type: 'init' }
  | { type: 'decode'; nals: Uint8Array[]; ptsUs: number; key?: boolean }
  | { type: 'flush' }
  | { type: 'reset' }
  | { type: 'destroy' };

export type FromWorkerMessage =
  | { type: 'ready'; version: string }
  | { type: 'frame'; frame: VideoFrameData }
  | { type: 'flushed' }
  | { type: 'ack' }
  | { type: 'error'; code: 'DECODE' | 'UNSUPPORTED'; message: string };
