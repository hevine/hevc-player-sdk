import { describe, it, expect } from 'vitest';
import { detectMediaType, looksLikeAudio } from '../src/media-type';
import { resolveVisualOptions } from '../src/render/spectrum';

describe('媒体类型探测', () => {
  it('显式提示优先', () => {
    expect(detectMediaType('/x.mp4', 'mp4', 'video/mp4', 'audio')).toBe('audio');
    expect(detectMediaType('/x.mp3', undefined, 'audio/mpeg', 'video')).toBe('video');
  });

  it('按 URL 后缀识别音频', () => {
    for (const ext of ['mp3', 'm4a', "wav", 'aac', 'ogg', 'opus', 'flac', 'weba']) {
      expect(detectMediaType(`/lesson.${ext}`)).toBe('audio');
    }
    expect(looksLikeAudio('/a/music.MP3?token=1')).toBe(true);
  });

  it('按 URL 后缀识别视频', () => {
    for (const ext of ['mp4', 'flv', 'hevc', 'h265', '265', 'm4v', 'mov']) {
      expect(detectMediaType(`/video.${ext}`)).toBe('video');
    }
  });

  it('按 sourceKind 识别视频流', () => {
    expect(detectMediaType('/live', 'ws-flv')).toBe('video');
    expect(detectMediaType('/live', 'raw')).toBe('video');
  });

  it('按 Content-Type 识别音频并默认视频', () => {
    expect(detectMediaType('/stream?id=1', 'url', 'audio/mpeg')).toBe('audio');
    expect(detectMediaType('/unknown', 'url', 'application/octet-stream')).toBe('video');
  });

  it('从 query 中提取音频后缀', () => {
    expect(detectMediaType('/media?file=/song.mp3')).toBe('audio');
  });
});

describe('音频可视化配置', () => {
  it('填充默认值', () => {
    const o = resolveVisualOptions();
    expect(o.barCount).toBe(64);
    expect(o.fftSize).toBe(2048);
    expect(o.smoothing).toBeCloseTo(0.8);
    expect(o.gain).toBeCloseTo(1.4);
    expect(o.showHalo).toBe(true);
    expect(o.showBars).toBe(true);
  });

  it('fftSize 规整到 2 的幂并夹紧范围', () => {
    expect(resolveVisualOptions({ fftSize: 1000 }).fftSize).toBe(1024);
    expect(resolveVisualOptions({ fftSize: 99 }).fftSize).toBe(128);
    expect(resolveVisualOptions({ fftSize: 1 << 20 }).fftSize).toBe(32768);
  });

  it('夹紧越界参数', () => {
    const o = resolveVisualOptions({ barCount: 999, smoothing: 5, gain: -1 });
    expect(o.barCount).toBe(160);
    expect(o.smoothing).toBeCloseTo(0.99);
    expect(o.gain).toBeCloseTo(0.1);
  });
});
