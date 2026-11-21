# @waiyu/hevc-player

> 独立的 **H.265 / HEVC 播放器 SDK**：纯 WASM 软解，支持**点播文件**与**实时流**，提供框架无关内核 + React 封装。
> 为「外语考证宝典」的播放器升级而设计，但**与主应用零耦合**，可独立发布、独立演进。
> **v0.2 起新增 `MediaPlayer`：一套视觉外壳同时兼容「视频」与「纯音频」两种媒体**——视频走 H265 软解显示画面，纯音频走原生播放 + Web Audio 实时频谱柱 / 呼吸光晕。

## 📚 文档导航

| 文档 | 用途 |
|---|---|
| 本文件 `README.md` | 对外 API、安装、快速开始、能力边界 |
| `INTEGRATION-GUIDE.md` | **接入主项目**：如何把 SDK 装进「外语考证宝典」、逐文件改动、验收与回滚 |
| `ARCHITECTURE-AND-GUIDE.md` | **学习与迭代**：整体架构、数据流、核心设计、踩坑记录、扩展点、调试手册 |
| `PRESENTATION-SCRIPT.md` | **介绍逐字稿**：照着念就能讲清这个组件，含 3 分钟精简版 |

---

## 1. 为什么独立

`HANDOVER-PLAYER.md` 描述的是现有**音频**播放器（`speechSynthesis` + Edge TTS），而 H.265 是**视频**编解码，两者技术栈不重叠。同时原项目有「零重型依赖」约束，而 H.265 解码必须引入 WASM 解码器（约 360KB）。因此本 SDK 作为**独立代码库**存在：

- 不动现有 `useVoicePlayer` / `useSpeech`，不碰主应用的任何一行代码；
- 解码内核、状态机、事件、背压完全独立；
- 通过标准 npm 包 / 子路径被主应用按需引入。

---

## 2. 技术选型

| 维度 | 选择 | 理由 |
|---|---|---|
| 解码内核 | `@yume-chan/libde265`（libde265 的 WASM 构建） | 纯软解、API 干净、pts 透传；**无需 SharedArrayBuffer / COOP-COEP**，部署简单 |
| 运行位置 | Web Worker | 解码是计算密集型，绝不阻塞主线程 |
| 解封装 | 自研 Annex-B + 轻量 FLV demuxer + `mp4box`（MP4） | 覆盖实时流与点播；无重型播放器框架 |
| 渲染 | Canvas2D（YUV420p→RGB，BT.601 查表） | 零依赖、全浏览器兼容 |
| 音画同步 | 播放时钟 + PTS 对齐 + 按渲染进度节流解码 | 解码不快进、低丢帧 |
| 打包 | Vite library mode；WASM 与 Worker **内联进单文件** | 发布即一个 JS，无外部 wasm/worker 资源 |

> **关于"硬解"**：按需求选择了纯 WASM 软解路线，兼容所有浏览器（含 Firefox、国产浏览器、无 HEVC 硬件的机器）。代价是 CPU 占用较高，1080P 以上多画面场景建议评估硬件解码方案（未来可扩展 `DecodeBackend`）。

---

## 3. 能力矩阵

| 格式 / 场景 | sourceKind | 容器 | 可 seek | 状态 |
|---|---|---|---|---|
| MP4 点播（H.265/hvc1/hev1） | `mp4` / `url` | `mp4` | ✅ | 已实测 |
| Annex-B 裸流文件 | `raw` / `url` | `annexb` | ❌ | 已实测 |
| HTTP-FLV 流（CodecID=12） | `flv` / `url` | `flv` | ❌ | 已实现 |
| WS-FLV 实时流 | `ws-flv` | `flv` | ❌ | 已实现 |
| WS-Annex-B 实时流 | `ws-raw` | `annexb` | ❌ | 已实现 |

**限制（v0.1 视频内核）**：
- 仅解码 HEVC Main Profile / 8-bit / 4:2:0；10bit(Main10) 与 4:2:2/4:4:4 未适配渲染。
- H265Player 中 AAC 音轨识别但未接入解码播放；**纯音频场景请用 `MediaPlayer`（音频能力完整）**。
- FLV 的 HEVC 走 Enhanced RTMP 规范（CodecID=12）；老式私有封装可能不兼容。
- 单路播放；多路分屏未做 SIMD / 多线程优化。

### 3.1 统一播放器：视频 / 纯音频一套 API（v0.2）

`MediaPlayer` 在同一块 canvas 上按媒体类型自动选择后端，视觉层统一：

| 媒体类型 | 后端 | 视觉呈现 | 能力 |
|---|---|---|---|
| 视频（MP4/FLV/裸流 H265） | `H265Player`（WASM 软解 Worker） | YUV→RGB 视频画面 | 播放/暂停/seek/倍速/低延迟 |
| 纯音频（mp3/m4a/wav/aac/ogg/flac…） | 原生 `<audio>` + Web Audio `AnalyserNode` | **实时频谱柱 + 呼吸光晕**（对数分桶、快起慢落平滑、镜像倒影） | 播放/暂停/seek/倍速/音量/静音 + 频谱数据 |

- 类型自动探测：显式 `mediaType` > `sourceKind` > URL 后缀 / Blob MIME > Content-Type，默认 `video`。
- 切换类型时自动销毁旧后端、重建新后端，事件与状态统一转发，不会串台。
- 频谱可视化来自真实音频数据（`getSpectrum()` 可拿原始频域数组供宿主自定义）；Web Audio 不可用时回退原生播放 + 静态视觉。
- 跨域音频需资源允许 CORS 并设 `audioCrossOrigin: true`，否则浏览器不给出频域数据（播放不受影响）。

---

## 4. 安装

```bash
npm install @waiyu/hevc-player
# React 封装为可选子路径，需项目已有 react/react-dom
```

浏览器要求：WebAssembly + Web Worker + Canvas2D（所有现代浏览器均满足）。**无需** COOP/COEP 响应头。

---

## 5. 快速开始（框架无关内核）

```ts
import { H265Player } from '@waiyu/hevc-player';

const canvas = document.querySelector<HTMLCanvasElement>('#video')!;
const player = new H265Player({ canvas, logLevel: 'warn' });

player.on('error', (err) => console.error(err.code, err.userMessage));
player.on('ready', (info) => console.log('分辨率', info.width, info.height));

await player.load({ url: '/lesson.mp4', sourceKind: 'mp4' });
player.play();

// 控制
player.pause();
player.play();
await player.seek(30_000_000); // 30 秒（微秒）
player.setRate(1.5);

// 销毁
await player.destroy();
```

实时流：

```ts
await player.load({ url: 'wss://example.com/live/lesson.flv', sourceKind: 'ws-flv' });
player.play();
```

### 5.1 统一播放器（视频 + 纯音频）

```ts
import { MediaPlayer } from '@waiyu/hevc-player';

const player = new MediaPlayer({
  canvas,
  audio: { barCount: 64, haloColor: '#4f7cff' }, // 可选：音频视觉定制
});

// 视频：自动识别为 H265 后端，显示画面
await player.load({ url: '/lesson.mp4', sourceKind: 'mp4' });
player.play();

// 纯音频：自动识别为音频后端，显示频谱柱 + 呼吸光晕
await player.load({ url: '/listening.mp3', mediaType: 'audio' });
player.setVolume(0.8);
player.play();

// 取真实频谱数据做自定义可视化（可选）
const bands = player.getSpectrum(); // Uint8Array | null

// 也能反切回视频；切换时旧后端自动销毁，不会串台
await player.load({ url: '/lesson2.mp4', mediaType: 'video' });
player.on('error', (e) => console.error(e.userMessage));
await player.destroy();
```

`MediaPlayer.load()` 额外支持 `mediaType`（`'auto' | 'video' | 'audio'`）与 `title`；其余参数与 `H265Player.load()` 一致。

---

## 6. React 封装

```tsx
import { H265PlayerView, type H265PlayerHandle } from '@waiyu/hevc-player/react';
import { useRef } from 'react';

function LessonPlayer() {
  const ref = useRef<H265PlayerHandle>(null);
  return (
    <>
      <H265PlayerView
        ref={ref}
        src="/lesson.mp4"
        sourceKind="mp4"
        canvasStyle={{ width: 640 }}
        onReady={(info) => console.log(info.width, info.height)}
        onError={(e) => alert(e.userMessage)}
      />
      <button onClick={() => ref.current?.play()}>播放</button>
      <button onClick={() => ref.current?.pause()}>暂停</button>
    </>
  );
}
```

或用 Hook 自绘控制栏：

```tsx
import { useH265Player } from '@waiyu/hevc-player/react';

function CustomPlayer() {
  const { canvasRef, state, stats, load, play, pause } = useH265Player({ sourceKind: 'mp4' });
  return (
    <>
      <canvas ref={canvasRef} />
      <button onClick={() => load({ url: '/lesson.mp4' }).then(play)}>加载并播放</button>
      <button onClick={pause}>暂停</button>
      <div>{state} · 解码 {stats?.decodedFrames} 帧</div>
    </>
  );
}
```

### 6.1 统一组件（音频 / 视频一套 UI）

```tsx
import { MediaPlayerView, type MediaPlayerHandle } from '@waiyu/hevc-player/react';
import { useRef } from 'react';

function UniversalPlayer({ src, type }: { src: string; type: 'audio' | 'video' }) {
  const ref = useRef<MediaPlayerHandle>(null);
  return (
    <>
      <MediaPlayerView
        ref={ref}
        src={src}
        mediaType={type}
        audio={{ barCount: 64, haloColor: '#c9a8ff' }}
        onMediaTypeChange={(t) => console.log('实际后端:', t)}
        onError={(e) => alert(e.userMessage)}
      />
      <button onClick={() => ref.current?.play()}>播放</button>
      <button onClick={() => ref.current?.pause()}>暂停</button>
      <input type="range" min={0} max={1} step={0.01} defaultValue={1}
             onChange={(e) => ref.current?.setVolume(Number(e.target.value))} />
    </>
  );
}
```

Hook 形式：`useMediaPlayer(options)` 返回 `canvasRef / state / info / mediaType / stats / load / play / pause / stop / seek / setRate / setVolume / setMuted / getSpectrum`。

---

## 7. API 参考

### `new H265Player(options: PlayerOptions)`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `canvas` | `HTMLCanvasElement` | 必填 | 渲染目标 |
| `sourceKind` | `SourceKind` | `'url'` | `url`/`mp4`/`flv`/`raw`/`ws-flv`/`ws-raw` |
| `container` | `ContainerFormat` | 自动 | 强制容器格式 |
| `ignoreAudio` | `boolean` | `false` | 忽略音轨 |
| `renderer` | `RendererKind` | `'canvas2d'` | 当前仅 canvas2d |
| `dropPolicy` | `DropPolicy` | 按源推断 | `realtime`（直播）/`all`（点播） |
| `maxBufferedFrames` | `number` | `30` | 帧缓冲上限（1~600） |
| `lowLatency` | `boolean` | `false` | 低延迟渲染 |
| `logLevel` | `LogLevel` | `'warn'` | 日志级别 |
| `headers` | `object` | `{}` | HTTP 自定义头（鉴权） |
| `timeoutMs` | `number` | `15000` | 请求/握手超时 |

### 方法

| 方法 | 说明 |
|---|---|
| `load(opts): Promise<void>` | 加载媒体；等待元数据就绪后 resolve |
| `play()` / `pause()` / `stop()` | 播放控制 |
| `seek(us): Promise<void>` | 跳转（仅可 seek 源） |
| `setRate(rate)` | 倍速 |
| `getStats(): PlayerStats` | 解码帧数、丢帧、缓冲、FPS、位置等 |
| `on/once/off(event, fn)` | 事件订阅，返回取消订阅函数 |
| `destroy(): Promise<void>` | 释放所有资源 |

### 事件

`statechange` / `ready` / `frame` / `error` / `ended` / `buffering` / `log`

### 错误码

`INVALID_OPTION` `UNSUPPORTED` `NETWORK` `HTTP_STATUS` `DEMUX` `DECODE` `TIMEOUT` `ABORTED` `STATE` `RENDER`
每个 `PlayerError` 都有 `.code`（供分支）、`.message`（技术细节）、`.userMessage`（中文用户文案）、`.retryable`（是否建议重试）、`.isAbort`。

---

## 8. 架构

```
source/    数据源         HTTP(fetch) · WebSocket · File(Blob)
   ↓ 字节流
demux/     解封装         Annex-B 切分 · FLV(CodecID=12) · MP4(mp4box) → AccessUnit
   ↓ NALU + PTS
decoder/   解码           WasmDecoder(主线程代理) ↔ decoder.worker(libde265 WASM)
   ↓ YUV 平面帧
render/    渲染           Canvas2D YUV420p→RGB (BT.601)
   ↑
av/Clock + H265Player    播放时钟 · 状态机 · 背压节流 · 事件 · 错误归一化
```

分层原则：`H265Player`（控制器）编排流程，不含解码细节；`decoder`/`demux`/`source`/`render` 各司其职、可单测；服务层不依赖 DOM（除渲染）。

---

## 9. 开发 / 验证

```bash
npm install
npm run typecheck     # tsc 类型检查
npm test              # vitest 单元测试（19 项）
npm run build         # 产出 dist/（核心 + react 子路径 + .d.ts）
npm run dev           # 演示页 http://localhost:5188
```

演示页 `examples/basic/public/` 内含真实 H.265 测试流（MP4 与 Annex-B），可直接在浏览器验证解码。

已实测（headless Chrome）：
- MP4 点播：240 帧全部解码、0 丢帧、画布渲染出真实画面；
- Annex-B 裸流：91 帧解码、0 丢帧；
- 暂停冻结位置 / 续播 / 停止复位均通过；
- 生产 bundle 自包含（WASM + Worker 内联，0 外部资源）。

---

## 10. 许可与合规 ⚠️

- 本 SDK 源码：MIT。
- **解码内核 `libde265` 为 LGPL-3.0-only**（见其 `node_modules/@yume-chan/libde265/package.json`）。以动态/独立模块方式使用通常符合 LGPL，但**商业闭源分发前请法务确认**。
- **H.265/HEVC 涉及专利池（Access Advance / MPEG-LA 等）**，商业部署需单独评估专利授权，这与代码的开源许可无关。
- 演示用测试流来自 h265web.js 开源项目仓库，仅用于本地验证。

---

## 11. 与主应用集成建议

1. 主应用 `npm install` 本包（本地可用 `file:../hevc-player-sdk`）。
2. 若只需在「听力/口语视频」场景用，用 `<H265PlayerView src=... />` 即可，与现有 TTS 音频播放器并行不冲突。
3. 需要统一控制栏时，用 `useH265Player` 自绘，复用主应用现有样式体系。
4. 音频场景仍走现有 `useVoicePlayer`（本 SDK 不替代它）。
