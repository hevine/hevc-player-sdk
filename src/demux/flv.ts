import type { AccessUnit, Demuxer, DemuxSink } from './types';

/**
 * FLV 解封装器（支持 H.265 / CodecID=12 与 H.264 / CodecID=7）
 * ------------------------------------------------------------------
 * 覆盖 HTTP-FLV 直播与本地 FLV 文件。遵循 Enhanced RTMP 的 HEVC 封装：
 *  - VideoTag 首字节：高 4 位 FrameType，低 4 位 CodecID
 *  - HEVC(12) 第二字节为 PacketType：0=序列头(hvcC) 1=NALU 2=EOS
 *  - 序列头中提取 VPS/SPS/PPS，NALU 包中的长度前缀 NALU 转 Annex-B，
 *    关键帧前置参数集，供解码器正确初始化。
 * 兼容传统 4 字节长度前缀（AVC/HEVC）。
 */

const TAG_VIDEO = 9;
const TAG_AUDIO = 8;
const TAG_SCRIPT = 18;

const PKT_SEQ_HEADER = 0;
const PKT_NALU = 1;

export class FlvDemuxer implements Demuxer {
  readonly seekable = false;

  private buf = new Uint8Array(0);
  private headerParsed = false;
  private paramNals: Uint8Array[] = []; // VPS/SPS/PPS (Annex-B with start code)
  private lastKeyPtsUs = 0;

  constructor(private readonly sink: DemuxSink) {}

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    let pos = 0;
    if (!this.headerParsed) {
      if (this.buf.length < 13) return; // FLV header(9) + PreviousTagSize0(4)
      // 校验 'FLV'
      if (this.buf[0] !== 0x46 || this.buf[1] !== 0x4c || this.buf[2] !== 0x56) {
        throw new Error('Not an FLV stream');
      }
      pos = 9 + 4;
      this.headerParsed = true;
    }

    while (pos < this.buf.length) {
      // Tag header 需要 11 字节
      if (this.buf.length - pos < 11) break;
      const tagType = this.buf[pos]!;
      const dataSize =
        (this.buf[pos + 1]! << 16) | (this.buf[pos + 2]! << 8) | this.buf[pos + 3]!;
      const tsLow = (this.buf[pos + 4]! << 16) | (this.buf[pos + 5]! << 8) | this.buf[pos + 6]!;
      const tsExt = this.buf[pos + 7]!;
      const timestampMs = tsExt * 0x1000000 + tsLow;
      const tagDataStart = pos + 11;
      const tagDataEnd = tagDataStart + dataSize;
      const nextPos = tagDataEnd + 4; // + PreviousTagSize

      if (this.buf.length < nextPos) break; // tag 未收全

      const payload = this.buf.subarray(tagDataStart, tagDataEnd);
      if (tagType === TAG_VIDEO) {
        this.handleVideo(payload, timestampMs);
      } else if (tagType === TAG_AUDIO && this.sink.onAudio) {
        this.handleAudio(payload, timestampMs);
      }
      pos = nextPos;
    }

    // 保留未解析的尾部
    this.buf = pos > 0 ? this.buf.slice(pos) : this.buf;
  }

  private handleVideo(payload: Uint8Array, timestampMs: number): void {
    if (payload.length < 2) return;
    const frameType = payload[0]! >> 4; // 1=key, 2=inter
    const codecId = payload[0]! & 0x0f;
    const isHevc = codecId === 12;
    const isAvc = codecId === 7;
    if (!isHevc && !isAvc) return; // 忽略其它编码

    const key = frameType === 1;
    let offset = 1;
    let ctsMs = 0;
    let packetType: number;

    if (isHevc) {
      // Enhanced RTMP: PacketType(1) + CompositionTime(3, SI24)
      packetType = payload[offset++]!;
      if (payload.length >= offset + 3) {
        ctsMs = readSi24(payload, offset);
        offset += 3;
      }
      if (packetType === PKT_SEQ_HEADER) {
        this.paramNals = parseHvcCToAnnexB(payload.subarray(offset));
        return;
      }
      if (packetType !== PKT_NALU) return; // EOS 等忽略
    } else {
      // AVC: AVCPacketType(1) + CompositionTime(3)
      packetType = payload[offset++]!;
      if (payload.length >= offset + 3) {
        ctsMs = readSi24(payload, offset);
        offset += 3;
      }
      if (packetType === 0) return; // AVC sequence header 本 SDK 不支持 H264 解码，跳过
      if (packetType !== 1) return;
    }

    const nals = isHevc
      ? lengthPrefixedToAnnexB(payload, offset, 4) // HEVC 用 4 字节长度
      : lengthPrefixedToAnnexB(payload, offset, 4);

    if (nals.length === 0) return;
    const ptsUs = (timestampMs + ctsMs) * 1000;
    const withParams = key && isHevc ? [...this.paramNals, ...nals] : nals;

    this.sink.onUnit({
      nals: withParams,
      ptsUs,
      key,
      durationUs: undefined,
    });
    if (key) this.lastKeyPtsUs = ptsUs;
  }

  private handleAudio(payload: Uint8Array, timestampMs: number): void {
    if (payload.length < 2) return;
    const soundFormat = payload[0]! >> 4;
    if (soundFormat !== 10) return; // 仅 AAC
    const isSeqHeader = payload[1] === 0;
    if (isSeqHeader) return; // 序列头交给音频管线处理（本 SDK v0.1 音频为 best-effort）
    this.sink.onAudio?.(payload.subarray(2), timestampMs * 1000);
  }

  flush(): void {
    this.buf = new Uint8Array(0);
  }

  reset(): void {
    this.buf = new Uint8Array(0);
    this.headerParsed = false;
    this.paramNals = [];
    this.lastKeyPtsUs = 0;
  }
}

/** 有符号 24 位（composition time） */
function readSi24(buf: Uint8Array, offset: number): number {
  let v = (buf[offset]! << 16) | (buf[offset + 1]! << 8) | buf[offset + 2]!;
  if (v & 0x800000) v -= 0x1000000;
  return v;
}

/** 长度前缀 NALU → Annex-B（带 start code） */
function lengthPrefixedToAnnexB(buf: Uint8Array, offset: number, lengthSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const sc = [0x00, 0x00, 0x00, 0x01];
  let pos = offset;
  while (pos + lengthSize <= buf.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = (len << 8) | buf[pos + i]!;
    pos += lengthSize;
    if (len <= 0 || pos + len > buf.length) break;
    const nal = buf.subarray(pos, pos + len);
    const annex = new Uint8Array(sc.length + nal.length);
    annex.set(sc, 0);
    annex.set(nal, sc.length);
    out.push(annex);
    pos += len;
  }
  return out;
}

/** 解析 hvcC 配置盒，提取 VPS/SPS/PPS 为 Annex-B NALU */
function parseHvcCToAnnexB(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  try {
    // hvcC: configurationVersion(1) general_profile... (21 bytes) then numOfArrays(1)
    if (data.length < 24) return out;
    const numArrays = data[22]!;
    let pos = 23;
    const sc = [0x00, 0x00, 0x00, 0x01];
    for (let a = 0; a < numArrays && pos < data.length; a++) {
      const arrayCompleteness = data[pos]! & 0x80;
      const nalType = data[pos]! & 0x3f;
      const numNalus = (data[pos + 1]! << 8) | data[pos + 2]!;
      pos += 3;
      for (let i = 0; i < numNalus && pos + 2 <= data.length; i++) {
        const nalLen = (data[pos]! << 8) | data[pos + 1]!;
        pos += 2;
        if (pos + nalLen > data.length) break;
        const nal = data.subarray(pos, pos + nalLen);
        const annex = new Uint8Array(sc.length + nal.length);
        annex.set(sc, 0);
        annex.set(nal, sc.length);
        out.push(annex);
        pos += nalLen;
      }
      void arrayCompleteness;
      void nalType;
    }
  } catch {
    return [];
  }
  return out;
}
