/**
 * 播放时钟（音画同步基准）
 * ------------------------------------------------------------------
 * 以 performance.now() 为墙钟，维护"媒体时间"映射。视频帧按 ptsUs
 * 与时钟对齐：早到则等待，迟到则在实时模式下跳过。
 * 支持 pause/resume（暂停时冻结媒体时间）、seek（重置基准）、rate（倍速）。
 */
export class Clock {
  private baseMediaUs = 0;
  private baseWallMs = 0;
  private paused = true;
  private rate = 1;

  /** 以给定媒体时间启动/重启时钟 */
  start(mediaUs = 0): void {
    this.baseMediaUs = mediaUs;
    this.baseWallMs = performance.now();
    this.paused = false;
  }

  /** 暂停：冻结当前媒体时间 */
  pause(): void {
    if (this.paused) return;
    this.baseMediaUs = this.nowUs();
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.baseWallMs = performance.now();
    this.paused = false;
  }

  seek(mediaUs: number): void {
    this.baseMediaUs = mediaUs;
    this.baseWallMs = performance.now();
  }

  setRate(rate: number): void {
    const now = this.nowUs();
    this.baseMediaUs = now;
    this.baseWallMs = performance.now();
    this.rate = rate > 0 ? rate : 1;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 当前媒体时间（微秒） */
  nowUs(): number {
    if (this.paused) return this.baseMediaUs;
    return this.baseMediaUs + (performance.now() - this.baseWallMs) * 1000 * this.rate;
  }
}
