/// <reference lib="webworker" />
import initialize, { type Decoder, type Image, type MainModule, type Error as Libde265Error } from '@yume-chan/libde265';
import wasmUrl from '@yume-chan/libde265/libde265.wasm?url';
import type { FromWorkerMessage, ToWorkerMessage } from './protocol';
import type { VideoFrameData } from '../types';

/**
 * 解码 Worker
 * ------------------------------------------------------------------
 * 唯一职责：接收一组 NALU → 调用 libde265 解码 → 回传 YUV 平面帧。
 * 不碰 DOM、不碰网络、不碰状态机。WASM 通过 locateFile 显式指向 Vite
 * 内联后的 wasm URL，避免相对路径与 import.meta.url 在 blob worker 中失效。
 */

const ALLOWED_ERRORS = new Set<number>([
  0, // OK
  13, // ERROR_WAITING_FOR_INPUT_DATA（正常：等待后续 NALU）
]);

let Module: MainModule | null = null;
let decoder: Decoder | null = null;

function post(msg: FromWorkerMessage, transfer?: Transferable[]): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);
}

/** 剥离 Annex-B start code，返回裸 NALU */
function stripStartCode(nal: Uint8Array): Uint8Array {
  if (nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) {
    return nal.subarray(4);
  }
  if (nal.length >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1) {
    return nal.subarray(3);
  }
  return nal;
}

function copyPlane(plane: { bytes: Uint8Array; width: number; height: number; stride: number }) {
  // getImagePlane 返回的是 WASM 堆上的视图，必须拷贝一份再 transfer，
  // 否则 decode 复用缓冲区会踩踏已回传的帧数据。
  return {
    bytes: new Uint8Array(plane.bytes),
    width: plane.width,
    height: plane.height,
    stride: plane.stride,
  };
}

function drainPictures(fallbackPtsUs: number, key: boolean): void {
  if (!Module || !decoder) return;
  let guard = 0;
  while (guard++ < 512) {
    const image: Image | null = decoder.getNextPicture();
    if (!image) break;
    try {
      const y = copyPlane(image.getImagePlane(0));
      const u = copyPlane(image.getImagePlane(1));
      const v = copyPlane(image.getImagePlane(2));
      const pts = image.pts;
      const frame: VideoFrameData = {
        y: y.bytes,
        u: u.bytes,
        v: v.bytes,
        width: y.width,
        height: y.height,
        strideY: y.stride,
        strideU: u.stride,
        strideV: v.stride,
        ptsUs: pts > 0n ? Number(pts) : fallbackPtsUs,
        key,
      };
      post({ type: 'frame', frame }, [y.bytes.buffer, u.bytes.buffer, v.bytes.buffer]);
    } finally {
      image.delete(); // 必须释放，否则 IMAGE_BUFFER_FULL
    }
  }
}

async function init(): Promise<void> {
  try {
    Module = await initialize({ locateFile: () => wasmUrl });
    decoder = new Module.Decoder();
    post({
      type: 'ready',
      version: `${Module.get_version_major()}.${Module.get_version_minor()}.${Module.get_version_maintenance()}`,
    });
  } catch (err) {
    post({
      type: 'error',
      code: 'UNSUPPORTED',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function resetDecoder(): void {
  if (decoder) {
    try {
      decoder.reset();
    } catch {
      // reset 失败不致命，重建解码器兜底
      decoder.delete();
      decoder = Module ? new Module.Decoder() : null;
    }
  }
}

self.onmessage = (event: MessageEvent<ToWorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void init();
      break;

    case 'decode': {
      if (!Module || !decoder) {
        post({ type: 'error', code: 'DECODE', message: 'Decoder not initialized' });
        return;
      }
      try {
        const pts = BigInt(Math.round(msg.ptsUs));
        for (const nal of msg.nals) {
          // pushNal 需要裸 NALU（不含 start code），剥离开头的 00 00 01 / 00 00 00 01
          const bare = stripStartCode(nal);
          if (bare.byteLength === 0) continue;
          decoder.pushNal(bare, pts);
          try { decoder.pushEndOfNal(); } catch { /* ignore */ }
        }
        // 显式标记帧结束，触发 libde265 输出重排帧
        try { decoder.pushEndOfFrame(); } catch { /* ignore */ }
        // 一次推入可能产生多帧（B 帧重排），循环取尽。
        let more = true;
        let guard = 0;
        while (more && guard++ < 1024) {
          const result = decoder.decode();
          const errCode = result.error as number;
          if (!ALLOWED_ERRORS.has(errCode) && errCode < 1000) {
            post({
              type: 'error',
              code: 'DECODE',
              message: Module.getErrorText(result.error as Libde265Error),
            });
            break;
          }
          drainPictures(msg.ptsUs, msg.key ?? false);
          more = result.more;
        }
        // 每个 access unit 处理完发一次 ack，用于背压计数
        post({ type: 'ack' });
      } catch (err) {
        post({
          type: 'error',
          code: 'DECODE',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'flush':
      if (decoder) {
        try {
          decoder.flushData();
          drainPictures(0, false);
        } catch {
          // 流结束时 flush 偶发异常可忽略
        }
      }
      post({ type: 'flushed' });
      break;

    case 'reset':
      resetDecoder();
      break;

    case 'destroy':
      if (decoder) {
        try {
          decoder.delete();
        } catch {
          /* noop */
        }
        decoder = null;
      }
      Module = null;
      (self as unknown as DedicatedWorkerGlobalScope).close();
      break;
  }
};
