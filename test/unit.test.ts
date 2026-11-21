import { describe, it, expect } from 'vitest';
import { StateMachine } from '../src/core/state-machine';
import { resolveConfig, detectContainer } from '../src/core/config';
import { PlayerError, playerError } from '../src/errors';
import { AnnexBSplitter } from '../src/demux/annex-b';
import { Canvas2DRenderer } from '../src/render/canvas2d';
import type { AccessUnit } from '../src/demux/types';

// jsdom 不在此项目依赖中，DOM 相关测试用最小 stub
class FakeCanvasElement {
  width = 0;
  height = 0;
  getContext() {
    return {
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => undefined,
    };
  }
}
// 提供全局 HTMLCanvasElement 桩，使 resolveConfig 的 instanceof 校验通过
(globalThis as unknown as { HTMLCanvasElement: typeof FakeCanvasElement }).HTMLCanvasElement = FakeCanvasElement;
const fakeCanvas = new FakeCanvasElement() as unknown as HTMLCanvasElement;

describe('StateMachine', () => {
  it('初始为 idle，合法迁移生效', () => {
    const sm = new StateMachine();
    expect(sm.state).toBe('idle');
    expect(sm.transition('loading')).toBe('loading');
    expect(sm.transition('ready')).toBe('ready');
    expect(sm.transition('playing')).toBe('playing');
  });

  it('拒绝非法迁移', () => {
    const sm = new StateMachine();
    expect(() => sm.transition('playing')).toThrow();
  });

  it('force 可强制迁移（错误/销毁路径）', () => {
    const sm = new StateMachine();
    sm.transition('error', true);
    expect(sm.state).toBe('error');
  });

  it('onChange 回调按序触发', () => {
    const changes: Array<[string, string]> = [];
    const sm = new StateMachine((a, b) => changes.push([a, b]));
    sm.transition('loading');
    sm.transition('ready');
    expect(changes).toEqual([
      ['idle', 'loading'],
      ['loading', 'ready'],
    ]);
  });
});

describe('config', () => {
  it('缺少 canvas 时快速失败', () => {
    expect(() => resolveConfig({} as never)).toThrow(PlayerError);
  });

  it('默认配置正确', () => {
    const c = resolveConfig({ canvas: fakeCanvas });
    expect(c.backend).toBe('wasm');
    expect(c.dropPolicy).toBe('all');
    expect(c.maxBufferedFrames).toBe(30);
    expect(c.logLevel).toBe('warn');
  });

  it('直播源默认 realtime 丢帧策略', () => {
    const c = resolveConfig({ canvas: fakeCanvas, sourceKind: 'ws-flv' });
    expect(c.dropPolicy).toBe('realtime');
  });

  it('非法 maxBufferedFrames 被拒绝', () => {
    expect(() => resolveConfig({ canvas: fakeCanvas, maxBufferedFrames: 0 })).toThrow();
  });
});

describe('detectContainer', () => {
  it('按 URL 后缀推断', () => {
    expect(detectContainer('url', 'a.flv')).toBe('flv');
    expect(detectContainer('url', 'a.mp4?token=x')).toBe('mp4');
    expect(detectContainer('url', 'a.h265')).toBe('annexb');
  });
  it('显式指定优先', () => {
    expect(detectContainer('url', 'a.bin', undefined, 'mp4')).toBe('mp4');
  });
  it('sourceKind 兜底', () => {
    expect(detectContainer('raw', '')).toBe('annexb');
    expect(detectContainer('mp4', '')).toBe('mp4');
  });
});

describe('errors', () => {
  it('错误码与可重试标记', () => {
    expect(playerError.http(500, 'x').retryable).toBe(true);
    expect(playerError.http(404, 'x').retryable).toBe(false);
    expect(playerError.aborted().isAbort).toBe(true);
  });
  it('每种错误码都有中文 userMessage', () => {
    const codes = ['INVALID_OPTION','UNSUPPORTED','NETWORK','HTTP_STATUS','DEMUX','DECODE','TIMEOUT','ABORTED','STATE','RENDER'] as const;
    for (const code of codes) {
      const e = new PlayerError(code, 'x');
      expect(e.userMessage.length).toBeGreaterThan(0);
    }
  });
  it('fromUnknown 归一化', () => {
    expect(PlayerError.fromUnknown(new Error('x')).code).toBe('DECODE');
    expect(PlayerError.fromUnknown(playerError.network('x')).code).toBe('NETWORK');
  });
});

describe('AnnexBSplitter', () => {
  function makeNal(type: number, payload = 4): Uint8Array {
    const nal = new Uint8Array(1 + payload);
    nal[0] = (type << 1) | 1; // forbidden=0, nal_type
    return nal;
  }
  function withSc(nal: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + nal.length);
    out.set([0, 0, 0, 1], 0);
    out.set(nal, 4);
    return out;
  }

  it('按 VCL 边界切分 access unit', () => {
    const units: AccessUnit[] = [];
    const splitter = new AnnexBSplitter({ onUnit: (u) => units.push(u) }, 25);
    // VPS + SPS + PPS + IDR + P帧
    const stream = new Uint8Array([
      ...withSc(makeNal(32)), ...withSc(makeNal(33)), ...withSc(makeNal(34)),
      ...withSc(makeNal(19)), ...withSc(makeNal(1)),
    ]);
    splitter.push(stream);
    splitter.flush();
    expect(units.length).toBe(2); // 一个 IDR 帧 + 一个 P 帧
    expect(units[0]!.key).toBe(true);
    expect(units[0]!.nals.length).toBe(4); // 3 参数集 + IDR
    expect(units[1]!.key).toBe(false);
  });

  it('跨 chunk 边界正确拼接', () => {
    const units: AccessUnit[] = [];
    const splitter = new AnnexBSplitter({ onUnit: (u) => units.push(u) }, 25);
    const full = new Uint8Array([...withSc(makeNal(19)), ...withSc(makeNal(1))]);
    splitter.push(full.subarray(0, 5));
    splitter.push(full.subarray(5));
    splitter.flush();
    expect(units.length).toBe(2);
  });

  it('reset 清空状态', () => {
    const units: AccessUnit[] = [];
    const splitter = new AnnexBSplitter({ onUnit: (u) => units.push(u) }, 25);
    splitter.push(withSc(makeNal(19)));
    splitter.reset();
    splitter.flush();
    expect(units.length).toBe(0);
  });
});

describe('Canvas2DRenderer', () => {
  it('resize 设置画布尺寸', () => {
    const r = new Canvas2DRenderer(fakeCanvas);
    r.resize(320, 180);
    expect(fakeCanvas.width).toBe(320);
    expect(fakeCanvas.height).toBe(180);
    r.destroy();
  });

  it('render 一帧不抛错', () => {
    const r = new Canvas2DRenderer(fakeCanvas);
    const w = 16, h = 16;
    r.render({
      y: new Uint8Array(w * h).fill(100),
      u: new Uint8Array(w / 2 * h / 2).fill(128),
      v: new Uint8Array(w / 2 * h / 2).fill(128),
      width: w, height: h,
      strideY: w, strideU: w / 2, strideV: w / 2,
      ptsUs: 0, key: true,
    });
    r.destroy();
  });
});
