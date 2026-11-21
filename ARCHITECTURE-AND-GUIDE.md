# 播放器 SDK 学习与迭代详解

> 配套文档：接入主项目见同目录 `INTEGRATION-GUIDE.md`；对外 API 见 `README.md`。
>
> 这份文档讲的是**为什么这么设计、内部怎么跑、以后怎么改**。建议按「先跑通 → 再读架构 → 再按扩展点动手」的顺序。

---

## 1. 它到底是什么（一句话定位）

一个**框架无关的播放器内核** `@waiyu/hevc-player`，对外一个 `MediaPlayer` 门面，**同一块 canvas 兼容两类媒体**：

- **H265/HEVC 视频**：自己解封装 + WASM 软解 + YUV→RGB 渲染（这是 SDK 的立身之本）；
- **纯音频**：浏览器原生 `<audio>` 播放 + Web Audio 取真实频谱 + 频谱柱/呼吸光晕渲染。

设计上的三个关键词：**零耦合**（不碰主应用任何代码）、**自包含**（WASM/Worker 内联进单个 JS）、**分层可替换**（每一层都能单换）。

代码规模约 3900 行 TS/TSX，源码在 `src/`。

---

## 2. 先跑起来（建立直觉）

```bash
cd /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk

npm install
npm run typecheck     # 类型检查
npm test              # vitest 单元测试（28 项）
npm run build         # 库构建 → dist/
npm run dev           # 演示页 http://localhost:5188
```

演示页有两个 tab：🎬 视频（H265 MP4）与 🎵 纯音频（内置合成 WAV + 频谱），先各点一遍，看到画面和频谱跳动再往下读。

> 演示素材：`examples/basic/public/` 下有 `test-hevc.mp4`（真 H265）、`test.hevc`（Annex-B 裸流）、`test-audio.wav`（Node 脚本合成的 8 秒和弦+低频脉冲）。WAV 是脚本生成的，不依赖 ffmpeg。

---

## 3. 整体架构与数据流

### 3.1 分层图

```
                         ┌─────────────────────────────────────┐
                         │  你的 App (React / 原生 JS 均可)      │
                         └──────────────────┬──────────────────┘
                                            │ 统一 API
                         ┌──────────────────▼──────────────────┐
                         │        MediaPlayer（门面/路由）        │
                         │  探测类型 → 选后端 → 转发事件/状态      │
                         └───────────┬──────────────┬───────────┘
                    video            │              │  audio
                         ┌───────────▼──────┐  ┌────▼────────────────┐
                         │   H265Player     │  │   AudioPlayer       │
                         │  （主控/状态机）   │  │（<audio>+AudioContext）│
                         └───────────┬──────┘  └────┬────────────────┘
                                     │               │
   ┌──────────────────────────────────┼──────┐        │ Web Audio AnalyserNode
   │  视频管线（每层可独立替换）         │      │        │
   │                                  ▼      │        ▼
   │  source/   →  demux/   →  decoder/  →  render/  render/spectrum.ts
   │  HTTP/WS    AnnexB/FLV/  WasmDecoder   Canvas2D   频谱柱+光晕
   │  File       MP4→AU       ↔ Worker     YUV→RGB
   └──────────────────────────────────────────┘
             横切关注点：core/(状态机/事件/日志/配置) · errors · av/clock
```

### 3.2 视频的一帧是怎么走到屏幕上的（最重要的一条链路）

跟着数据流走一遍，就理解了整个 SDK：

```
1. source        HttpSource/FileSource/WS 按块 next() 读字节
        │
2. demux         AnnexBSplitter / FlvDemuxer / Mp4Demuxer
        │        输出 AccessUnit = { nals: Uint8Array[], ptsUs, key }
        │        MP4 会把长度前缀 NALU 转 Annex-B，并前置 VPS/SPS/PPS
        ▼
3. pendingUnits  ★ 门面控速队列：demux 产出先入队，不立即解码
        │        runPump 按「渲染进度」逐条取，避免一次性解完整片
        ▼
4. WasmDecoder   decode() 把 NALU copy 到独立 buffer → transfer 给 Worker
        │        inFlight++ 计在途数，awaitDrain() 做背压
        ▼
5. Worker        stripStartCode(裸 NALU) → pushNal + pushEndOfNal
        │        pushEndOfFrame → 循环 decode() → drainPictures()
        │        getNextPicture → 拷贝 Y/U/V 平面 → transfer 回主线程
        ▼
6. frameQueue    主线程收帧入队；onDecodedFrame 计数/丢帧/发 buffering
        │
7. renderStep    requestAnimationFrame 里按 clock.nowUs() 与 ptsUs 对齐
        │        早到等待、迟到按策略丢弃
        ▼
8. Canvas2DRenderer  查表法 YUV420p→RGB(BT.601) → putImageData → 屏幕
```

**一句话记忆**：`source → demux → 队列 → worker 解码 → 帧队列 → 时钟对齐 → 渲染`。任何"没画面/卡顿/丢帧"问题，都能定位到这 8 步中的某一步。

### 3.3 音频的链路（短很多）

```
<audio>.src = url  →  loadedmetadata（时长/可 seek）→ ready
   │
   ├─ 音频输出：<audio> 原生播放（AudioContext 的 destination）
   │
   └─ 视觉输出：MediaElementSource → AnalyserNode.getByteFrequencyData
                      → SpectrumRenderer.render(bands, energy, time)
                      → 频谱柱 + 呼吸光晕 + 镜像倒影
```

音频后端**不经过** source/demux/decoder/clock 那套（浏览器已经做了），只复用 `core/`（状态机/事件/日志）与 `render/` 的视觉层。

---

## 4. 模块职责速查（改代码前先找对地方）

| 路径 | 职责 | 什么时候动它 |
|---|---|---|
| `src/types.ts` | 全部对外契约；不引用第三方类型 | 加新配置/事件/字段 |
| `src/H265Player.ts` | 视频主控：生命周期、数据泵、背压、帧调度、事件 | 播放流程/同步问题 |
| `src/MediaPlayer.ts` | 门面：类型探测结果、后端切换、事件转发 | 加第三种媒体类型 |
| `src/audio/AudioPlayer.ts` | 音频后端：原生播放 + Web Audio + 音量 | 音频能力/浏览器兼容 |
| `src/media-type.ts` | 媒体类型探测（显式 > sourceKind > 后缀 > MIME） | 加新音频/视频扩展名 |
| `src/core/state-machine.ts` | 显式状态迁移表，拒绝非法跃迁 | 加新状态 |
| `src/core/event-emitter.ts` | 类型安全事件，监听器异常隔离 | 一般不动 |
| `src/core/config.ts` | 集中校验 + 容器探测 | 加配置项/新容器后缀 |
| `src/core/logger.ts` | 结构化日志，可注入宿主 logger | 一般不动 |
| `src/av/clock.ts` | 媒体时间 ↔ 墙钟映射（pause/seek/rate） | 音画同步问题 |
| `src/source/{http,websocket,file}.ts` | 数据源，统一 `next()` 接口 | 加新传输协议 |
| `src/demux/{annex-b,flv,mp4}.ts` | 解封装成 AccessUnit | 加新封装格式 |
| `src/decoder/wasm-decoder.ts` | 主线程代理：Worker 管理、背压信用 | 解码调度问题 |
| `src/decoder/decoder.worker.ts` | 唯一解码处：libde265 → YUV 帧 | 解码错误/新解码器 |
| `src/decoder/protocol.ts` | 主线程 ↔ Worker 消息协议 | 加控制消息 |
| `src/render/canvas2d.ts` | YUV420p→RGB 的像素转换 | 色彩/性能问题 |
| `src/render/spectrum.ts` | 频谱视觉：分桶/平滑/光晕 | 音频视觉效果 |
| `src/errors.ts` | 类型化错误 + 中文 userMessage | 加错误码 |
| `src/react/*` | hook + 组件封装（可选子路径） | React 集成问题 |

---

## 5. 四个核心设计（理解它们=理解 SDK）

### 5.1 状态机：显式迁移，拒绝非法跃迁

`PlayerState` 有 8 态：`idle → loading → ready → playing → paused / seeking → ended / error`。

`StateMachine.transition()` 查一张迁移表，非法跃迁抛 `STATE` 错误；`force` 参数只用于错误/销毁路径复位。这样做的好处：

- 播放器的每一个状态变化都可预测、可广播（`statechange` 事件）；
- `load()` 会等待 `ready` 再返回（最多 timeout），所以调用方 `await load()` 后立刻 `play()` 是安全的——这是踩过坑后加的（MP4 元数据是异步解析的）。

> 调试技巧：状态卡住先看 `player.state`。`loading` 不转 `ready` 通常是元数据没来（检查 demux）；`playing` 无帧看下面的背压/解码链路。

### 5.2 背压与节流：为什么不"一口气解完整片"

这是视频链路最容易出错的地方，也是迭代时最容易被破坏的地方。

**问题**：解码（WASM）远快于 24fps 的渲染时钟。若在 demux 时立即 decode，帧队列瞬间堆满，导致大量丢帧 + 内存暴涨（240 帧 640×360 YUV ≈ 150MB）。

**解法（三层）**：

1. `pendingUnits` 队列：demux 产出先入队；
2. `awaitFrameRoom()`：点播源等帧队列降到阈值（`maxBufferedFrames/3`）才继续提交；
3. `WasmDecoder` 的 `inFlight` + `awaitDrain()`：限制在途解码单元数（默认 `maxBufferedFrames/3`）。

实测效果：MP4 240 帧全部解码、**0 丢帧**，缓冲稳定在 10 帧左右。直播源（`lowLatency` / `realtime`）则跳过节流，直接渲染最新帧、丢弃过期帧——**点播求全、直播求快**，这是两条不同的策略。

### 5.3 时钟与同步

`Clock` 把 `performance.now()`（墙钟）映射成媒体时间：`nowUs = baseMediaUs + (now - baseWallMs) * 1000 * rate`。

- `pause()` 冻结当前媒体时间，`resume()` 重置墙钟基准；
- `seek()` / `setRate()` 都重设基准（避免倍速跳变）；
- 渲染时比较 `frame.ptsUs <= clock.nowUs() + 16ms` 才出帧。

音频后端不用这个 Clock——`<audio>.currentTime` 就是它自己的时钟。

### 5.4 事件与错误

- `EventEmitter.on()` 返回取消订阅函数；emit 时快照监听器数组，单个监听器抛错被隔离，不影响主流程。
- 所有内部错误归一化为 `PlayerError`（稳定 `code` + 中文 `userMessage` + `retryable`），通过 `error` 事件广播。UI 只按 `code` 分支，不依赖易变的文案。
- `MediaPlayer` 把后端事件**原样转发**，宿主只订阅门面即可，不用关心当前是哪种后端。

---

## 6. 踩过的坑（血泪史，改代码前务必看）

> 这些是实测中真实踩到并修复的 bug，每条都对应一类"看起来对、实际不工作"的陷阱。

### 坑 1：`pushNal` 必须传裸 NALU，不能带 Annex-B start code

**现象**：WASM 初始化成功、元数据解析正常，但**解码帧数 0**。

**原因**：libde265 的 `pushNal()` 期望的是裸 NAL 单元字节，传入 `00 00 00 01` 开头的 Annex-B 数据它无法识别。

**修复**：`decoder.worker.ts` 的 `stripStartCode()` 剥掉 3/4 字节起始码；每个 NALU 后 `pushEndOfNal()`，一帧结束 `pushEndOfFrame()` 触发重排帧输出。

### 坑 2：MP4 的 VPS/SPS/PPS 在 hvcC 里，不在 sample 里

**现象**：MP4 首帧是 IDR（type 20），但没有参数集 → 解不出画面。

**原因**：`track.samples` 在 `onReady` 时还不可用；参数集藏在 `stsd.entries[0].hvcC.nalu_arrays`，结构形如 `{ nalu_type, completeness, [i]: { data } }`。

**修复**：从 box 树取 hvcC，抽出 VPS(32)/SPS(33)/PPS(34)，前置到关键帧。另外 mp4box 2.5 的 `appendBuffer` 要传**累计 `fileStart` 偏移**，否则分片读取错位。

### 坑 3：transfer 给 Worker 时 ArrayBuffer detach

**现象**：`DataCloneError: ArrayBuffer is detached and could not be cloned`。

**原因**：多个 NALU 视图共享同一个底层 ArrayBuffer，transfer 第一个就把 buffer 脱离了。

**修复**：`WasmDecoder.decode()` 里逐条 `new Uint8Array(nal)` 复制到独立 buffer 再 transfer。同理，Worker 回传 Y/U/V 前也要 `copyPlane()`——`getNextPicture()` 返回的是 WASM 堆视图，复用缓冲区会踩踏已回传的帧；回传后必须 `image.delete()`，否则 `IMAGE_BUFFER_FULL`。

### 坑 4：解码快进导致海量丢帧（见 5.2）

**现象**：240 帧只渲染 30 帧，丢 209 帧。

**修复**：pendingUnits + awaitFrameRoom + 降低在途上限，三管齐下（详见 5.2）。

### 坑 5：SSR / 非浏览器环境的 `instanceof` 陷阱

**现象**：Node 环境（单测）里 `opts.canvas instanceof HTMLCanvasElement` 抛 `ReferenceError`，而不是预期的友好错误。

**修复**：先检查 `typeof HTMLCanvasElement === 'undefined'`，再做 `instanceof`。单测用最小 FakeCanvasElement stub。

### 坑 6：音频频谱需要用户手势 + CORS

- 浏览器自动播放策略：无用户手势时 `AudioContext` 处于 suspended。方案：在 `play()` 里 `audioCtx.resume()`；演示/测试时 Chrome 加 `--autoplay-policy=no-user-gesture-required`。
- 跨域音频：没有 CORS 授权的跨域资源，Web Audio 出于安全不提供频域数据（播放仍有声音）。方案：构造时设 `audioCrossOrigin: true` 且服务端返回 CORS 头。

---

## 7. 构建与自包含原理

`vite.config.ts` 用 library mode 产出两个入口：

- `dist/hevc-player.js` / `.cjs`：核心包（框架无关）
- `dist/react.js` / `.cjs`：React 绑定（react/react-dom 作为 peerDependency 外置）

**WASM 与 Worker 如何变成单文件**：Worker 用 `?worker&inline` 编成 base64 内联；WASM 用 `?url` 引入后由 Vite 内联成 data URI，Worker 里通过 `locateFile` 显式指向该 URL（blob worker 中 `import.meta.url` 相对路径会失效）。最终产物约 1.6MB（gzip ~590KB），**零外部资源文件**，0 个独立 `.wasm`。

> 验证自包含：解码 `dist/hevc-player.js` 里的最长 base64 串（内联 worker），应能在其中找到魔数 `0061736d`（`\0asm`）的 360KB WASM。

---

## 8. 怎么调试

| 现象 | 定位顺序 |
|---|---|
| 视频黑屏 | ① `state` 是否 playing ② `decodedFrames` 是否增长 ③ 素材是否真 HEVC（H264 不支持）④ 容器是否判错（显式 `sourceKind`/`container`）⑤ 看 console 的 `player error` code |
| 解码 0 帧 | 回到坑 1/2：start code 是否剥离、参数集是否前置 |
| 大量丢帧 | 看 5.2 三层节流是否被破坏；`maxBufferedFrames`/在途上限是否被改大 |
| 音频有声音无频谱 | 坑 6：CORS + `audioCrossOrigin` + 用户手势 |
| 状态卡在 loading | `load()` 等待 ready 超时（默认 15s）；检查数据源是否返回数据、demux 是否抛错 |
| 同屏串台 | 每个 `MediaPlayer` 有独立 sessionId，内核不会串；若 React 层串，看 `INTEGRATION-GUIDE.md` 阶段 2 的全局单例 |

**工具**：演示页暴露 `window.__mediaStats()` / `window.__mediaCtrl`（见 `examples/basic/main.ts`），可在 DevTools 直接读 stats / 调控制方法；SDK 支持注入 `logger` 接宿主日志。

**单元测试**：`test/unit.test.ts`（状态机/配置/错误/demux）、`test/media.test.ts`（类型探测/视觉配置），共 28 项。`npm test` 跑。

---

## 9. 常见扩展点（怎么迭代）

### 9.1 加一个音频/视频扩展名

改 `src/media-type.ts` 的 `AUDIO_EXT` / `VIDEO_EXT` 正则，补一条 `test/media.test.ts` 用例。

### 9.2 换/加解码后端（如硬解 WebCodecs、10bit）

`DecodeBackend` 已在 `types.ts` 预留扩展位（当前 `wasm / native-audio / native-audio-fallback`）。步骤：

1. 在 `types.ts` 加后端枚举值；
2. 实现一个符合 `Renderer`/解码契约的新类；
3. 在 `MediaPlayer.createBackend()` 或 `H265Player` 的解码器工厂里按条件选择；
4. 注意 10bit/4:2:2 需要改 `render/canvas2d.ts` 的像素转换（当前只支持 8bit 4:2:0）。

### 9.3 加新封装格式（如 TS / MKV）

在 `src/demux/` 新增一个实现 `Demuxer` 接口的类（输出统一的 `AccessUnit`），在 `core/config.ts` 的 `ContainerFormat` 和 `detectContainer()` 加识别，在 `H265Player.createDemuxer()` 挂载。

### 9.4 升级音频视觉（WebGL 频谱 / 专辑封面 / 波形）

当前视觉都在 `src/render/spectrum.ts` 的 `render()` 里（背景→光晕→频谱柱→倒影）。可：

- 换 WebGL2 版本（新增 `render/spectrum-webgl.ts`，在 `AudioPlayer` 里替换 renderer）；
- 加波形模式：`AnalyserNode.getByteTimeDomainData` + 新绘制分支；
- 加封面：在光晕中心 `drawImage`，配合 `mediaType`/`title` 元数据。

### 9.5 渲染性能（高分辨率多路）

`Canvas2DRenderer` 是逐像素查表（JS 循环），1080P 以上吃力。可换 WebGL2 + YUV→RGB shader（利用 GPU），`Renderer` 接口已经抽象好，替换不影响其它层。

### 9.6 接入主应用（见另一份文档）

`INTEGRATION-GUIDE.md` 给了分阶段方案：阶段 1 独立演示页 → 阶段 2 全局单例 + 融入业务页。

---

## 10. 测试与验收基线

改动后务必跑：

```bash
npm run typecheck   # 0 error
npm test            # 28/28
npm run build       # 通过且 dist 自包含
npm run dev         # 演示页人工点一遍视频 + 音频
```

真实浏览器回归（用 CDP / headless Chrome，音频测试需加 `--autoplay-policy=no-user-gesture-required`）：

- 视频：MP4 240 帧 0 丢帧、Annex-B 91 帧 0 丢帧、canvas 有真实像素；
- 音频：`decodeBackend === 'native-audio'`、频谱 1024 bin 有非零数据、canvas 非黑、暂停位置冻结、续播推进、停止回 idle。

---

## 11. 合规与边界

- **许可**：解码内核 `@yume-chan/libde265` 是 **LGPL-3.0**；H.265/HEVC 涉及专利池。内部 / 本地使用无碍，**商用发布前需法务评估**。SDK 自身 `package.json` 标 MIT，但依赖的 LGPL 义务仍需注意。
- **能力边界**：视频仅 8bit / 4:2:0 / HEVC Main Profile；音频格式取决于浏览器原生支持（mp3/m4a/wav/aac/ogg/flac 等）。
- **未做**：多路分屏、SIMD 多线程、10bit 渲染、字幕、DRM。

---

## 12. 一页速记（cheat sheet）

```
入口：MediaPlayer（门面）→ 自动探测 → H265Player(视频) / AudioPlayer(音频)
视频链：source → demux → pendingUnits → WasmDecoder→Worker → frameQueue → clock → Canvas2D
音频链：<audio> 播放 + AnalyserNode → SpectrumRenderer(频谱柱+光晕)
状态机：idle→loading→ready→playing→paused/seeking→ended/error
事件：statechange/ready/frame/error/ended/buffering/progress/volumechange/spectrum
四坑：裸NALU、hvcC参数集、buffer detach、解码节流
后端枚举：wasm / native-audio / native-audio-fallback
自包含：WASM+Worker 内联进单 JS，魔数 0061736d
构建：npm run typecheck && npm test && npm run build && npm run dev
接入主项目：见 INTEGRATION-GUIDE.md（file: 本地依赖 → 演示页 → 全局单例）
```
