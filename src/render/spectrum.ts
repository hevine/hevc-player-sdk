import type { AudioVisualOptions } from '../types';

/**
 * SpectrumRenderer —— 纯音频模式的视觉层
 * ------------------------------------------------------------------
 * 在同一块 canvas 上绘制：深色渐层背景 + 中心呼吸光晕 + 底部频谱柱（含镜像倒影）。
 * 频谱柱使用对数分桶映射到 FFT bins，带快起慢落平滑，静音时保留轻微呼吸律动。
 * 与 Canvas2DRenderer 共用 canvas，但两者生命周期互斥（由 MediaPlayer 保证）。
 */

export interface ResolvedVisualOptions {
  barCount: number;
  barColor: string;
  barColorTop: string;
  haloColor: string;
  background: string;
  fftSize: number;
  smoothing: number;
  gain: number;
  showHalo: boolean;
  showBars: boolean;
}

export function resolveVisualOptions(o?: AudioVisualOptions): ResolvedVisualOptions {
  const rawFft = o?.fftSize ?? 2048;
  const pow2 = Math.pow(2, Math.round(Math.log2(rawFft)));
  const fftSize = Math.max(32, Math.min(32768, pow2));
  return {
    barCount: Math.max(8, Math.min(160, Math.round(o?.barCount ?? 64))),
    barColor: o?.barColor ?? '#4f7cff',
    barColorTop: o?.barColorTop ?? '#7fd1ff',
    haloColor: o?.haloColor ?? '#4f7cff',
    background: o?.background ?? '#0b1020',
    fftSize,
    smoothing: Math.max(0, Math.min(0.99, o?.smoothing ?? 0.8)),
    gain: Math.max(0.1, Math.min(8, o?.gain ?? 1.4)),
    showHalo: o?.showHalo ?? true,
    showBars: o?.showBars ?? true,
  };
}

/** 十六进制颜色 → rgba 字符串 */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export class SpectrumRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: ResolvedVisualOptions;
  private smoothed: Float32Array;
  private energySmoothed = 0;
  private width = 0;
  private height = 0;
  private binRanges: Array<[number, number]> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options?: AudioVisualOptions,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建 2D 渲染上下文');
    this.ctx = ctx;
    this.opts = resolveVisualOptions(options);
    this.smoothed = new Float32Array(this.opts.barCount);
    this.ensureSize();
    this.buildBinRanges();
  }

  get kind(): string {
    return 'spectrum';
  }

  /** 确保画布有合理尺寸（沿用已有尺寸，过小则用 960×540） */
  ensureSize(): void {
    const w = this.canvas.width >= 320 ? this.canvas.width : 960;
    const h = this.canvas.height >= 180 ? this.canvas.height : 540;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private buildBinRanges(): void {
    const bins = Math.floor(this.opts.fftSize / 2);
    const count = this.opts.barCount;
    this.binRanges = [];
    // 对数分桶：低频细、高频粗，更贴近听感
    const minBin = 1;
    const maxBin = Math.max(minBin + count, Math.floor(bins * 0.82));
    for (let i = 0; i < count; i++) {
      const lo = Math.floor(minBin * Math.pow(maxBin / minBin, i / count));
      const hi = Math.max(lo + 1, Math.floor(minBin * Math.pow(maxBin / minBin, (i + 1) / count)));
      this.binRanges.push([Math.min(lo, bins - 1), Math.min(hi, bins)]);
    }
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /**
   * 渲染一帧
   * @param bands 频域字节数组（getByteFrequencyData 结果），静音时为 null
   * @param energy 瞬时能量，可由调用方覆盖；不传则按 bands 计算
   * @param timeMs 时间（毫秒），用于呼吸动画
   */
  render(bands: Uint8Array | null, energy: number | null, timeMs: number): number {
    this.ensureSize();
    const { ctx, width: w, height: h, opts } = this;
    const t = timeMs / 1000;

    // 1) 背景
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, opts.background);
    bg.addColorStop(1, '#05070f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // 计算每根柱的目标值与能量
    let sum = 0;
    const targets = new Float32Array(opts.barCount);
    if (bands && bands.length > 0) {
      for (let i = 0; i < opts.barCount; i++) {
        const [lo, hi] = this.binRanges[i] ?? [1, 2];
        let acc = 0;
        let n = 0;
        for (let b = lo; b < hi && b < bands.length; b++) {
          acc += bands[b]!;
          n++;
        }
        const avg = n > 0 ? acc / n : 0;
        targets[i] = Math.min(1, (avg / 255) * opts.gain);
        sum += avg / 255;
      }
    }
    const instant = energy ?? Math.min(1, (sum / Math.max(1, opts.barCount)) * opts.gain * 0.9);
    this.energySmoothed += (instant - this.energySmoothed) * 0.12;
    const e = this.energySmoothed;

    // 2) 呼吸光晕（静音时仍有缓慢律动，避免死黑）
    if (opts.showHalo) {
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.6);
      const idle = 0.06 + 0.04 * breathe;
      const intensity = Math.max(idle, e);
      const cx = w / 2;
      const cy = h * 0.44;
      const baseR = Math.min(w, h) * 0.34;
      const r = baseR * (0.86 + intensity * 0.35 + breathe * 0.03);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      halo.addColorStop(0, withAlpha(opts.haloColor, 0.05 + intensity * 0.24));
      halo.addColorStop(0.45, withAlpha(opts.haloColor, 0.03 + intensity * 0.12));
      halo.addColorStop(1, withAlpha(opts.haloColor, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // 双层同心呼吸环
      for (let k = 0; k < 2; k++) {
        const rr = r * (0.5 + k * 0.28);
        ctx.strokeStyle = withAlpha(opts.haloColor, (0.05 + intensity * 0.14) * (1 - k * 0.35));
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 3) 频谱柱
    if (opts.showBars) {
      const margin = Math.max(16, w * 0.045);
      const usable = w - margin * 2;
      const slot = usable / opts.barCount;
      const barW = Math.max(2, slot * 0.62);
      const baseline = h * 0.74;
      const maxBarH = h * 0.46;

      const grad = ctx.createLinearGradient(0, baseline - maxBarH, 0, baseline);
      grad.addColorStop(0, opts.barColorTop);
      grad.addColorStop(1, opts.barColor);

      for (let i = 0; i < opts.barCount; i++) {
        let target = targets[i] ?? 0;
        // 静音时保留轻微波形律动
        if (target < 0.01) {
          target = 0.012 + 0.018 * (0.5 + 0.5 * Math.sin(t * 2.2 + i * 0.35));
        }
        const cur = this.smoothed[i] ?? 0;
        // 快起慢落
        const coeff = target > cur ? 0.5 : 0.12;
        const v = cur + (target - cur) * coeff;
        this.smoothed[i] = v;

        const bh = Math.max(2, v * maxBarH);
        const x = margin + i * slot + (slot - barW) / 2;
        const y = baseline - bh;

        ctx.fillStyle = grad;
        this.roundRect(ctx, x, y, barW, bh, Math.min(barW / 2, 3));
        ctx.fill();

        // 顶部高光
        ctx.fillStyle = withAlpha('#ffffff', 0.22 * Math.min(1, v * 2));
        this.roundRect(ctx, x, y, barW, Math.min(2, bh), 1);
        ctx.fill();

        // 镜像倒影
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.translate(0, baseline * 2);
        ctx.scale(1, -1);
        ctx.fillStyle = grad;
        this.roundRect(ctx, x, y, barW, Math.min(bh, h - baseline), Math.min(barW / 2, 3));
        ctx.fill();
        ctx.restore();
      }

      // 基线
      ctx.fillStyle = withAlpha(opts.barColorTop, 0.18);
      ctx.fillRect(margin, baseline, usable, 1);
    }

    return e;
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  destroy(): void {
    this.smoothed = new Float32Array(0);
    this.binRanges = [];
  }
}
