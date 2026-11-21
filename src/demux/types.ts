/**
 * 解封装层公共契约
 * ------------------------------------------------------------------
 * 所有 demuxer 把容器字节流统一产出为 AccessUnit（一个可独立解码的
 * 视频帧 = 一组 NALU + 时间戳），屏蔽 MP4 / FLV / Annex-B 的差异。
 */

/** 一个视频接入单元（access unit） */
export interface AccessUnit {
  /** 该帧的 NALU 列表（Annex-B 格式，含 start code 或裸 NALU 均可，由 decoder 决定） */
  nals: Uint8Array[];
  /** 显示时间戳（微秒） */
  ptsUs: number;
  /** 是否随机接入点（关键帧） */
  key: boolean;
  /** 帧时长（微秒，可选） */
  durationUs?: number;
}

/** 解封装器输出回调 */
export interface DemuxSink {
  onUnit: (unit: AccessUnit) => void;
  onTrackInfo?: (info: { width: number; height: number; fps?: number; durationUs: number; codec: string }) => void;
  onAudio?: (data: Uint8Array, ptsUs: number) => void;
}

/** 解封装器统一接口 */
export interface Demuxer {
  /** 喂入一段字节；内部可缓冲，产出通过 sink 回调 */
  push(chunk: Uint8Array): void;
  /** 流结束，冲刷剩余数据 */
  flush(): void;
  /** 复位内部状态（seek / 换源） */
  reset(): void;
  /** 是否支持 seek */
  readonly seekable: boolean;
  /** seek 到指定微秒（若支持） */
  seek?(us: number): void;
}
