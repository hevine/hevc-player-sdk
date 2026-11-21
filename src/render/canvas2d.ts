import type { VideoFrameData } from '../types';
import { playerError } from '../errors';

/** 渲染器接口 */
export interface Renderer {
  render(frame: VideoFrameData): void;
  resize(width: number, height: number): void;
  destroy(): void;
  readonly kind: string;
}

/**
 * BT.601 有限范围 YUV420p → RGB 查找表
 *   R = 1.164*(Y-16) + 1.596*(V-128)
 *   G = 1.164*(Y-16) - 0.391*(U-128) - 0.813*(V-128)
 *   B = 1.164*(Y-16) + 2.018*(U-128)
 * 预乘 256 存整数，最后 >>8，全程整数运算。
 */
function buildLookupTables() {
  const yTable = new Int32Array(256); // 1.164*(Y-16)*256
  const uToR = new Int32Array(256);
  const uToG = new Int32Array(256);
  const uToB = new Int32Array(256); // 2.018*(U-128)*256
  const vToR = new Int32Array(256); // 1.596*(V-128)*256
  const vToG = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    yTable[i] = Math.round(1.164 * (i - 16) * 256);
    const d = i - 128;
    uToR[i] = 0;
    uToG[i] = Math.round(-0.391 * d * 256);
    uToB[i] = Math.round(2.018 * d * 256);
    vToR[i] = Math.round(1.596 * d * 256);
    vToG[i] = Math.round(-0.813 * d * 256);
  }
  return { yTable, uToR, uToG, uToB, vToR, vToG };
}

const LUT = buildLookupTables();

/**
 * Canvas2D 渲染器
 * ------------------------------------------------------------------
 * 用 ImageData 逐像素做 YUV420p→RGB（BT.601），putImageData 提交。
 * 兼容全部浏览器，作为默认渲染器。高分辨率场景建议宿主切 WebGL2。
 */
export class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d';
  private readonly ctx: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;
  private width = 0;
  private height = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw playerError.render('无法创建 2D 渲染上下文');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.imageData = this.ctx.createImageData(width, height);
  }

  render(frame: VideoFrameData): void {
    const { width, height, strideY, strideU, strideV, y, u, v } = frame;
    if (width !== this.width || height !== this.height) this.resize(width, height);
    const imageData = this.imageData;
    if (!imageData) return;
    const rgba = imageData.data;

    for (let row = 0; row < height; row++) {
      const yRow = row * strideY;
      const uvRow = (row >> 1) * strideU;
      const uvRowV = (row >> 1) * strideV;
      let out = row * width * 4;
      for (let col = 0; col < width; col++) {
        const Y = LUT.yTable[y[yRow + col]!];
        const uc = u[uvRow + (col >> 1)]!;
        const vc = v[uvRowV + (col >> 1)]!;
        let r = (Y + LUT.vToR[vc] + 128) >> 8;
        let g = (Y + LUT.uToG[uc] + LUT.vToG[vc] + 128) >> 8;
        let b = (Y + LUT.uToB[uc] + 128) >> 8;
        if (r < 0) r = 0;
        else if (r > 255) r = 255;
        if (g < 0) g = 0;
        else if (g > 255) g = 255;
        if (b < 0) b = 0;
        else if (b > 255) b = 255;
        rgba[out++] = r;
        rgba[out++] = g;
        rgba[out++] = b;
        rgba[out++] = 255;
      }
    }
    this.ctx.putImageData(imageData, 0, 0);
  }

  destroy(): void {
    this.imageData = null;
  }
}
