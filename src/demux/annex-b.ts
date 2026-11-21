import type { AccessUnit, Demuxer, DemuxSink } from './types';

/**
 * Annex-B H.265 裸流解封装器
 * ------------------------------------------------------------------
 * 通过 start code（00 00 01 / 00 00 00 01）切分 NALU，按 VCL NALU 边界
 * 聚合为 access unit。规则：
 *  - VPS(32)/SPS(33)/PPS(34)/SEI(39)/AUD(35) 等参数集归入下一帧前缀
 *  - 当遇到新的 VCL NALU（nal_type 0..31，且 first_slice_segment_in_pic_flag
 *    为真时新帧）时刷新上一帧
 * 这里用一个稳健的近似：以 primitive picture boundary（新的 VCL 且 POC/帧号变化）
 * 为界；若无法判断则每个 VCL NALU 单独成帧（对解码仍安全）。
 *
 * pts 来源：裸流通常无时间戳，用 fps 估算递增；直播用到达时间。
 */
const SC = [0x00, 0x00, 0x01];

export class AnnexBSplitter implements Demuxer {
  readonly seekable = false;

  private buffer = new Uint8Array(0);
  private pending: Uint8Array[] = [];
  private currentPtsUs: number;
  private readonly frameDurationUs: number;
  private sawVcl = false;

  constructor(
    private readonly sink: DemuxSink,
    fps = 25,
    startPtsUs = 0,
  ) {
    this.frameDurationUs = Math.round(1_000_000 / (fps || 25));
    this.currentPtsUs = startPtsUs;
  }

  push(chunk: Uint8Array): void {
    // 拼接残留 + 新数据
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    // 逐 start code 切分；保留最后一个未完整 NALU
    let searchFrom = 0;
    let scStart = -1;
    while ((scStart = findStartCode(this.buffer, searchFrom)) !== -1) {
      // 提取上一次 start code 到本次之间的 NALU
      if (this.lastScStart >= 0) {
        // 去掉尾部 0x00（annex-B trailing zero）
        let end = scStart;
        while (end > this.lastScStart && this.buffer[end - 1] === 0x00) end--;
        this.consumeNal(this.buffer.subarray(this.lastScStart, end));
      }
      this.lastScStart = scStart;
      searchFrom = scStart + 3;
    }
    // 保留从最后一个 start code 起的残留
    if (this.lastScStart >= 0) {
      this.buffer = this.buffer.slice(this.lastScStart);
      // lastScStart 现在恒为 0（相对 buffer）
      this.lastScStart = 0;
      searchFrom = 3;
    }
    void searchFrom;
  }

  private lastScStart = -1;

  private consumeNal(nalWithStartCode: Uint8Array): void {
    // 跳过 start code 得到 NALU header
    let offset = 0;
    if (nalWithStartCode[0] === 0 && nalWithStartCode[1] === 0 && nalWithStartCode[2] === 1) {
      offset = 3;
    } else if (
      nalWithStartCode.length > 3 &&
      nalWithStartCode[0] === 0 &&
      nalWithStartCode[1] === 0 &&
      nalWithStartCode[2] === 0 &&
      nalWithStartCode[3] === 1
    ) {
      offset = 4;
    }
    if (offset >= nalWithStartCode.length) return;
    const type = (nalWithStartCode[offset]! >> 1) & 0x3f;
    const isVcl = type <= 31;

    if (isVcl) {
      if (this.sawVcl) this.flushUnit(); // 上一个 VCL 结束 → 产出
      this.sawVcl = true;
    }
    // 参数集/SEI/VCL 都放入当前帧（参数集随关键帧一起前置）
    this.pending.push(nalWithStartCode.slice());
  }

  private flushUnit(): void {
    if (this.pending.length === 0) return;
    const unit: AccessUnit = {
      nals: this.pending,
      ptsUs: this.currentPtsUs,
      key: this.pending.some((n) => isKeyNal(n)),
      durationUs: this.frameDurationUs,
    };
    this.sink.onUnit(unit);
    this.currentPtsUs += this.frameDurationUs;
    this.pending = [];
  }

  flush(): void {
    // 冲刷尾部残留
    if (this.buffer.length > 0 && this.lastScStart >= 0) {
      let end = this.buffer.length;
      while (end > 0 && this.buffer[end - 1] === 0x00) end--;
      if (end > 0) this.consumeNal(this.buffer.subarray(0, end));
    }
    this.flushUnit();
    this.buffer = new Uint8Array(0);
    this.lastScStart = -1;
    this.sawVcl = false;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
    this.pending = [];
    this.lastScStart = -1;
    this.sawVcl = false;
    this.currentPtsUs = 0;
  }
}

function findStartCode(buf: Uint8Array, from: number): number {
  for (let i = from; i < buf.length - 2; i++) {
    if (buf[i] === SC[0] && buf[i + 1] === SC[1] && buf[i + 2] === SC[2]) return i;
  }
  return -1;
}

function isKeyNal(nal: Uint8Array): boolean {
  let offset = 0;
  if (nal[0] === 0 && nal[1] === 0 && nal[2] === 1) offset = 3;
  else if (nal.length > 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) offset = 4;
  if (offset >= nal.length) return false;
  const header = nal[offset]!;
  const type = (header >> 1) & 0x3f;
  // IDR_W_RADL(19) / IDR_N_LP(20) / CRA(21)
  if (type === 19 || type === 20 || type === 21) return true;
  // 普通 VCL：first_slice_segment_in_pic_flag（header 最高位）为 1 视为随机接入近似
  if (type <= 9 && (header & 0x80) !== 0) return true;
  return false;
}
