import { createFile, type ISOFile, type Movie, type Sample, type Track } from 'mp4box';
import type { AccessUnit, Demuxer, DemuxSink } from './types';

/**
 * MP4 点播解封装器（基于 mp4box）
 * ------------------------------------------------------------------
 * 从 ISOFile 提取 HEVC 视频轨样本。mp4box 的 onSamples 返回的 sample.data
 * 是 length-prefixed NALU（hvcC 描述），本层：
 *  1) 从 stsd.entries[0].hvcC.nalu_arrays 提取 VPS/SPS/PPS 参数集（关键）
 *  2) 每个 sample 的 NALU 转 Annex-B，关键帧前置参数集
 *  3) cts/timescale → 微秒时间戳
 * 支持 seek。hvcC 结构（mp4box 2.5）：nalu_arrays[i] = {nalu_type, completeness, 0..n: {data}}
 */

const START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

export class Mp4Demuxer implements Demuxer {
  readonly seekable = true;

  private readonly file: ISOFile;
  private videoTrackId = -1;
  private timescale = 1;
  private paramNals: Uint8Array[] = [];
  private ready = false;
  private disposed = false;
  private fileOffset = 0;

  constructor(private readonly sink: DemuxSink) {
    this.file = createFile(true);
    this.file.onReady = (info: Movie) => this.handleReady(info);
    this.file.onError = (module, message) => {
      this.sink.onUnit; // keep reference
    };
    this.file.onSamples = (id, _user, samples) => this.handleSamples(id, samples);
  }

  private handleReady(info: Movie): void {
    const video = info.videoTracks.find((t: Track) => /hvc1|hev1|hevc/i.test(t.codec)) ?? info.videoTracks[0];
    if (!video) throw new Error('MP4 中没有视频轨');

    this.videoTrackId = video.id;
    this.timescale = video.timescale || 1;
    const width = video.video?.width ?? 0;
    const height = video.video?.height ?? 0;
    const durationUs = Math.round((video.duration / this.timescale) * 1_000_000);
    const fps = video.nb_samples > 0 && durationUs > 0
      ? Math.round((video.nb_samples / (durationUs / 1_000_000)) * 100) / 100
      : undefined;

    // 从 box 树提取 hvcC 参数集（mp4box 在 onReady 时 track.samples 尚不可用）
    this.paramNals = this.extractParamNals(video.id);

    this.sink.onTrackInfo?.({ width, height, fps, durationUs, codec: video.codec });
    this.file.setExtractionOptions(this.videoTrackId, undefined, { nbSamples: 30 });
    this.file.start();
    this.ready = true;
  }

  /** 从 mp4box box 树定位视频轨的 hvcC，提取 VPS/SPS/PPS */
  private extractParamNals(videoTrackId: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    try {
      const moov = this.file.boxes.find((b) => b.type === 'moov') as unknown as {
        boxes?: Array<Record<string, unknown>>;
      } | undefined;
      const traks = (moov?.boxes ?? []).filter((b) => b.type === 'trak') as Array<{
        boxes?: Array<Record<string, unknown>>;
      }>;
      for (const trak of traks) {
        // 用 tkhd.track_id 匹配视频轨
        const tkhd = (trak.boxes ?? []).find((b) => b.type === 'tkhd') as { track_id?: number } | undefined;
        if (tkhd?.track_id !== videoTrackId) continue;
        const minf = ((trak.boxes ?? []).find((b) => b.type === 'mdia') as { boxes?: Array<Record<string, unknown>> })?.boxes
          ?.find((b) => b.type === 'minf') as { boxes?: Array<Record<string, unknown>> } | undefined;
        const stbl = (minf?.boxes ?? []).find((b) => b.type === 'stbl') as { boxes?: Array<Record<string, unknown>> } | undefined;
        const stsd = (stbl?.boxes ?? []).find((b) => b.type === 'stsd') as {
          entries?: Array<Record<string, unknown>>;
        } | undefined;
        const entry = stsd?.entries?.[0] as { hvcC?: HvcCBox } | undefined;
        const hvcC = entry?.hvcC;
        if (!hvcC?.nalu_arrays) break;
        for (const arr of hvcC.nalu_arrays) {
          // 仅取 VPS(32)/SPS(33)/PPS(34)，跳过 SEI(39)
          if (arr.nalu_type !== 32 && arr.nalu_type !== 33 && arr.nalu_type !== 34) continue;
          for (let i = 0; i < arr.length; i++) {
            const nal = arr[i] as { data?: Uint8Array } | undefined;
            if (!nal?.data || nal.data.length === 0) continue;
            const annex = new Uint8Array(START_CODE.length + nal.data.length);
            annex.set(START_CODE, 0);
            annex.set(nal.data, START_CODE.length);
            out.push(annex);
          }
        }
        break;
      }
    } catch {
      return [];
    }
    return out;
  }

  private handleSamples(id: number, samples: Sample[]): void {
    if (id !== this.videoTrackId || this.disposed) return;
    for (const sample of samples) {
      if (!sample.data || sample.data.byteLength === 0) continue;
      const nals = lengthPrefixedToAnnexB(sample.data, 4);
      if (nals.length === 0) continue;
      const withParams = sample.is_sync ? [...this.paramNals, ...nals] : nals;
      const ptsUs = Math.round(((sample.cts ?? sample.dts) / this.timescale) * 1_000_000);
      const durationUs = Math.round((sample.duration / this.timescale) * 1_000_000);
      this.sink.onUnit({ nals: withParams, ptsUs, key: sample.is_sync, durationUs });
    }
  }

  push(chunk: Uint8Array): void {
    if (this.disposed) return;
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
    const buffer = Object.assign(ab, { fileStart: this.fileOffset });
    this.fileOffset += chunk.byteLength;
    this.file.appendBuffer(buffer);
  }

  flush(): void {
    if (this.disposed) return;
    const tail = Object.assign(new ArrayBuffer(0), { fileStart: this.fileOffset });
    this.file.appendBuffer(tail, true);
  }

  seek(us: number): void {
    if (!this.ready) return;
    this.file.seek(us / 1_000_000, true);
    this.file.setExtractionOptions(this.videoTrackId, undefined, { nbSamples: 30 });
  }

  reset(): void {
    // ISOFile 不可原地复位；由上层重建实例
  }
  resetOffset(startByte = 0): void {
    this.fileOffset = startByte;
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.file.stop();
    } catch {
      /* ignore */
    }
  }
}

interface HvcCArray {
  nalu_type: number;
  completeness: number;
  length: number;
  [index: number]: { data: Uint8Array };
}
interface HvcCBox {
  nalu_arrays?: HvcCArray[];
}

function lengthPrefixedToAnnexB(buf: Uint8Array, lengthSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let pos = 0;
  while (pos + lengthSize <= buf.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = (len << 8) | buf[pos + i]!;
    pos += lengthSize;
    if (len <= 0 || pos + len > buf.length) break;
    const nal = buf.subarray(pos, pos + len);
    const annex = new Uint8Array(START_CODE.length + nal.length);
    annex.set(START_CODE, 0);
    annex.set(nal, START_CODE.length);
    out.push(annex);
    pos += len;
  }
  return out;
}
