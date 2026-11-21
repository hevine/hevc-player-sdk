# 接入指南：在「外语考证宝典」集成统一音视频播放器

> **文档用途**：给新任务 / 新 agent 的一站式接入说明。照着做完，就能在主应用里用**一套播放器**播放 H265 视频与纯音频（含频谱可视化），且与现有 TTS 朗读链路零耦合。
>
> **目标 SDK**：`@waiyubaodian/hevc-player` v0.2，源码位于
> `/Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk/`
>
> **主项目**：`/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian/`
>
> 配套的「学习 & 迭代详解」见同目录 `ARCHITECTURE-AND-GUIDE.md`。

---

## 0. 开工前必读（不做会踩坑）

1. **Node 版本**：主项目的 `better-sqlite3` 是按 Node 24 编译的，PATH 默认 Node 是 22，直接跑会报 `NODE_MODULE_VERSION 137`。所有主项目命令都要加前缀：

   ```bash
   PATH=/usr/local/bin:$PATH npm run dev        # 前端 5199 + 后端 4399
   PATH=/usr/local/bin:$PATH npm run typecheck
   PATH=/usr/local/bin:$PATH npm run build
   ```

   SDK 本身无原生依赖，用默认 Node 22 即可独立构建 / 测试。

2. **交接文档硬约束**（`HANDOVER-PLAYER.md` 第 6 节，务必遵守）：
   - 云端 API Key 永不出后端；
   - 音色按 `word / sentence / article / listening` 场景隔离，不能全局覆盖；
   - 播放失败必须降级，不能哑掉；
   - **零重型依赖**（不要引入 howler / tone / zustand 之类）——SDK 正是按此约束设计的；
   - 考试作答接口不下发答案，不要改 item 结构。

3. **本 SDK 与现有 TTS 播放器的边界**（最重要）：
   - 现有 `useVoicePlayer` / `useSpeech` / `useVoiceSystem` 是**浏览器语音合成 + Edge TTS 云端合成**，负责「把文字读出来」；
   - 本 SDK 是**播放真实媒体文件**（H265 视频 / 音频文件），负责「把一段已存在的音/视频放出来」；
   - **两者互不替代、互不耦合**。本接入是**新增能力**，不改任何现有朗读代码。首次接入建议只做一个独立演示页，验证通过后再谈替换。

---

## 1. 接入目标（本次任务范围）

| # | 交付项 | 验收标准 |
|---|---|---|
| 1 | SDK 以本地包形式接入主项目 | `npm install` 后可 `import` 到 `MediaPlayer`，typecheck 通过 |
| 2 | 新增一个演示/功能页「媒体播放器」 | 能播 H265 视频显示画面；能播音频显示频谱柱 + 呼吸光晕 |
| 3 | 授予路由入口 | 侧栏或某页面有入口可进入（HashRouter） |
| 4 | 不破坏现有功能 | 现有朗读、考试、音色库全部回归正常；typecheck / build 通过 |
| 5 | 全局单例，杜绝串台 | 同屏多个播放器实例时，播放一个另一个立即复位（对应 P0-1） |

> 建议**分两步**：先做「阶段 1 最小接入」（一个独立页面），跑通后再做「阶段 2 产品化」（单例 + 融入业务页）。

---

## 2. SDK 准备（一次性的前置动作）

SDK 是独立代码库，尚未发布到 npm。有三种接入方式，**推荐 A（file 本地依赖）**，改动最小、可热更新迭代。

### 方式 A：本地 `file:` 依赖（推荐）

```bash
# 1) 在 SDK 目录先构建出 dist（主项目用的是 dist 里的产物）
cd /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk
npm install
npm run build        # 产出 dist/，含 ESM/CJS + .d.ts；WASM/Worker 已内联进单文件

# 2) 在主项目安装本地包
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
npm install file:/Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk
```

这会在 `package.json` 写入 `"@waiyubaodian/hevc-player": "file:..."`，并在 `node_modules/@waiyubaodian/hevc-player` 建立符号链接。

> **迭代注意**：SDK 每次改完源码都要重新 `npm run build`；主项目因为是软链，`dist` 更新后刷新页面即可生效（Vite 缓存异常时 `npm run clean:cache`）。

### 方式 B：`npm pack` 本地 tarball（交付快照）

```bash
cd /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk
npm pack            # 生成 waiyubaodian-hevc-player-0.2.0.tgz
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
npm install /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk/waiyubaodian-hevc-player-0.2.0.tgz
```

适合给主项目一个「冻结版本」，不受 SDK 后续改动影响。

### 方式 C：发布到 npm / 私有 registry

```bash
cd /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk
npm publish --access public        # 或配置私有 registry
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
npm install @waiyubaodian/hevc-player@0.2
```

> ⚠️ 合规：SDK 用了 `@yume-chan/libde265`（**LGPL-3.0**），H265 涉及专利池。商用发布前请法务评估（见 SDK README）。本地 / 内网使用不受此限。

### 验证接入成功

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
PATH=/usr/local/bin:$PATH node -e "import('@waiyubaodian/hevc-player').then(m=>console.log(Object.keys(m)))"
# 期望输出含 MediaPlayer, H265Player, AudioPlayer, detectMediaType ...
```

---

## 3. 阶段 1：最小接入（新建一个演示页）

### 3.1 SDK 对外 API 速查

```ts
import { MediaPlayer, detectMediaType } from '@waiyubaodian/hevc-player';
import { MediaPlayerView, useMediaPlayer } from '@waiyubaodian/hevc-player/react'; // React 子路径

// 核心容器：MediaPlayer（一套 API 兼容两种媒体）
new MediaPlayer({
  canvas,                                  // HTMLCanvasElement，必填
  mediaType: 'auto',                       // auto | video | audio
  audio: { barCount: 64, haloColor: '#4f7cff' }, // 可选：音频视觉定制
  volume: 1,
  logLevel: 'warn',
});

player.load({ url, sourceKind?, mediaType?, container?, startUs?, title? }); // Promise
player.play(); player.pause(); player.stop();
await player.seek(us); player.setRate(rate);
player.setVolume(0..1); player.setMuted(bool);
player.getStats(); player.getSpectrum(); // Uint8Array | null
player.mediaType;  // 'video' | 'audio' | null
await player.destroy();

// 事件：statechange / ready / frame / error / ended / buffering / progress / volumechange / spectrum
```

> `H265Player` 仍保留，纯视频场景可继续直接用；新代码统一用 `MediaPlayer`。

### 3.2 需要新增 / 修改的文件

```
web/src/pages/MediaPlayerDemo.tsx     ← 新增：演示页（组件 + 逻辑）
web/src/App.tsx                       ← 修改：加一条路由 /media-player
web/src/components/Layout.tsx         ← 修改（可选）：侧栏加入口
web/src/styles.css                    ← 修改（可选）：播放器样式
public/media/                         ← 新增（可选）：放测试用的视频/音频文件
```

### 3.3 新建演示页（可直接复制）

`web/src/pages/MediaPlayerDemo.tsx`：

```tsx
/**
 * 媒体播放器演示页：一套 UI 播放 H265 视频与纯音频。
 * 与现有 TTS 朗读链路（useVoicePlayer / useSpeech）完全独立。
 */
import { useRef, useState } from 'react';
import { MediaPlayerView, type MediaPlayerHandle } from '@waiyubaodian/hevc-player/react';
import type { MediaType } from '@waiyubaodian/hevc-player';

const DEMOS = {
  video: '/media/demo-hevc.mp4',   // 需自备 H265 编码的 mp4
  audio: '/media/demo-audio.mp3',  // 任意 mp3/wav 均可
};

export default function MediaPlayerDemo() {
  const ref = useRef<MediaPlayerHandle>(null);
  const [src, setSrc] = useState<string>(DEMOS.video);
  const [type, setType] = useState<MediaType | 'auto'>('auto');
  const [state, setState] = useState('idle');
  const [volume, setVolume] = useState(100);

  const switchDemo = (t: 'video' | 'audio') => {
    setType(t);
    setSrc(DEMOS[t]);
    // 换源时先停止旧后端，避免串台
    ref.current?.stop();
  };

  return (
    <div className="card card-pad">
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>媒体播放器（视频 / 纯音频）</h2>

      <div className="player-bar" style={{ marginBottom: 12 }}>
        <button className="btn btn-sm" onClick={() => switchDemo('video')}>🎬 视频</button>
        <button className="btn btn-sm" onClick={() => switchDemo('audio')}>🎵 音频</button>
        <span className="divider-v" />
        <button className="btn btn-primary btn-sm" onClick={() => ref.current?.play()}>播放</button>
        <button className="btn btn-sm" onClick={() => ref.current?.pause()}>暂停</button>
        <button className="btn btn-sm" onClick={() => ref.current?.stop()}>停止</button>
        <span className="spacer" />
        <span className="hint">状态：{state}</span>
      </div>

      <MediaPlayerView
        key={src}                       // 换源时强制重挂载 canvas，最省心
        ref={ref}
        src={src}
        mediaType={type}
        sourceKind={type === 'video' ? 'mp4' : 'url'}
        autoPlay={false}
        audio={{ barCount: 64, haloColor: '#4f7cff' }}
        canvasStyle={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 8 }}
        onStateChange={setState}
        onMediaTypeChange={(t) => console.log('实际后端：', t)}
        onError={(e) => console.error(e.code, e.userMessage)}
      />

      <label className="hint" style={{ display: 'block', marginTop: 12 }}>
        音量 {volume}%
        <input
          type="range" min={0} max={100} value={volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            ref.current?.setVolume(v / 100);
          }}
        />
      </label>
    </div>
  );
}
```

**关键点说明**：

- `key={src}` 让换源时组件重挂载，是最省心的隔离手段；生产环境可改为调用 `load()` 让 `MediaPlayer` 内部切换后端。
- `sourceKind` 视频传 `mp4`、音频传 `url`（音频由 URL 后缀 / MIME 自动识别，无需 demux 参数）。
- `autoPlay={false}`：主项目有严格的自动播放约束，建议由用户手势触发 `play()`。
- 组件只负责 `<canvas>` 和生命周期，控制栏完全由宿主自绘，因此可以直接套用主项目的 `.btn / .card / .player-bar` 样式。

### 3.4 加路由

在 `web/src/App.tsx` 顶部 import：

```ts
import MediaPlayerDemo from './pages/MediaPlayerDemo';
```

在 `<Routes key={planKey}>` 内加一行（放在 `/settings` 前即可）：

```tsx
<Route path="/media-player" element={<MediaPlayerDemo />} />
```

> 若希望「无需计划也能进」，把该路由移到 `plan ? ...` 判断之外（参考 `/path` 路由的写法）。

### 3.5 加侧栏入口（可选）

在 `web/src/components/Layout.tsx` 的导航项数组里加一项：

```ts
{ to: '/media-player', label: '媒体播放器', icon: /* 复用现有图标组件 */ },
```

具体结构以文件现状为准；找不到时先手动改地址栏 `#/media-player` 验证页面。

### 3.6 测试素材

- **音频**：任意 mp3/wav 放 `web/public/media/demo-audio.mp3`（Vite 中 `web` 是 root，`public/` 下文件用 `/media/...` 访问）。若 `web/public` 不存在就新建。
- **视频**：需 **H265/HEVC 编码** 的 mp4。SDK 演示工程里已有现成测试文件可复制：

  ```bash
  mkdir -p /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian/web/public/media
  cp /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk/examples/basic/public/test-hevc.mp4 \
     /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian/web/public/media/demo-hevc.mp4
  cp /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk/examples/basic/public/test-audio.wav \
     /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian/web/public/media/demo-audio.wav
  ```

  并把示例里的 `DEMOS.audio` 改成 `/media/demo-audio.wav`。

### 3.7 阶段 1 验收

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian
PATH=/usr/local/bin:$PATH npm run typecheck   # 0 error
PATH=/usr/local/bin:$PATH npm run build       # 通过
PATH=/usr/local/bin:$PATH npm run dev         # 打开 http://localhost:5199/#/media-player
```

- [ ] 点「视频」加载后有画面（不是黑屏），播放/暂停/停止正常
- [ ] 点「音频」加载后有频谱柱 + 呼吸光晕，能听到声音，音量滑块生效
- [ ] 切换两种媒体不报错、不串台
- [ ] 现有朗读、考试、音色库页面回归正常

---

## 4. 阶段 2：产品化（可选，按需取用）

### 4.1 全局单例，杜绝串台（对应 P0-1）

现有朗读播放器的 P0-1 是「同屏两个实例互相打断且状态卡死」。SDK 的设计已经规避了内核串台（每个 `MediaPlayer` 独立 sessionId），但**多个 React 组件实例同时存在**时仍需全局协调。推荐在 `web/src/hooks/` 新增一个轻量单例 hook：

```ts
// web/src/hooks/useSharedMediaPlayer.ts
import { useEffect, useRef, useState } from 'react';
import { MediaPlayer } from '@waiyubaodian/hevc-player';
import type { MediaPlayerOptions, PlayerState } from '@waiyubaodian/hevc-player';

let shared: MediaPlayer | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** 全局唯一播放器：任一组件播放前先 stop 其它，彻底消除跨实例残留 */
export function useSharedMediaPlayer(options: Omit<MediaPlayerOptions, 'canvas'>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<PlayerState>('idle');
  const [instance, setInstance] = useState<MediaPlayer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!shared) {
      shared = new MediaPlayer({ ...options, canvas });
    }
    const p = shared;
    setInstance(p);
    const off = p.on('statechange', () => { setState(p.state); notify(); });
    listeners.forEach((fn) => fn());
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { canvasRef, instance, state };
}
```

> 这是**参考骨架**，落地时按 `HANDOVER-PLAYER.md` 阶段 A 的 `useSyncExternalStore` 方案做更规范。关键是「全局一个 owner、播放前先 stop、广播状态」。

### 4.2 融入业务页的典型场景

| 场景 | 位置 | 接入方式 |
|---|---|---|
| 精读/听力材料配真人音视频 | `ReadingPlayer.tsx` 加一个「媒体」标签页 | 用 `MediaPlayerView`，`mediaType` 由素材字段决定 |
| 考试听力（替代全库 0 条的 `audio_url`） | `ExamTake.tsx:405` 的 `<audio controls>` | 换成 `MediaPlayerView`，保留「两遍限制」逻辑（监听 `ended` 计数） |
| 单词/例句配发音音频 | `WordDeck.tsx` | 音频文件用 `MediaPlayer`，文字发音仍走 `useVoicePlayer`，两者按来源分流 |

**音频来源判定建议**（避免两套播放器抢同一内容）：

```ts
// 有真实音频文件 → MediaPlayer；只有文本 → 现有 useVoicePlayer
const mode = item.audioUrl ? 'media' : 'tts';
```

因为交接文档明确 `audio_url` 全库 0 条，现阶段多数内容仍走 TTS；媒体播放器先作为「有真人音视频时的增强通道」存在。

### 4.3 与现有样式融合

`MediaPlayerView` 只输出一个 `<canvas>`，不注入任何样式。用主项目 `web/src/styles.css` 里的 `.player-bar / .card / .btn / .hint / .divider-v` 拼控制栏即可，`canvasStyle` 建议：

```tsx
canvasStyle={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 8, background: '#0b1020' }}
```

窄屏（375px）下注意控制栏 `flex-wrap: wrap`，这是交接文档验收清单的一条。

---

## 5. 验证清单（逐条过）

**工程**
- [ ] `PATH=/usr/local/bin:$PATH npm run typecheck` → 0 error
- [ ] `PATH=/usr/local/bin:$PATH npm run build` → 通过
- [ ] 控制台无 SDK 相关报错；网络面板无 404（媒体地址正确）

**视频**
- [ ] H265 mp4 能解码出画面（首帧约 100ms WASM 初始化）
- [ ] 播放 / 暂停 / 停止 / seek / 倍速正常
- [ ] 同屏多实例点一个，另一个复位（阶段 2）

**音频**
- [ ] 能听到声音；频谱柱随声音跳动，呼吸光晕随能量变化
- [ ] 暂停后位置冻结、继续后推进
- [ ] 音量 / 静音生效
- [ ] 跨域音频：资源需允许 CORS，且构造时设 `audioCrossOrigin: true`，否则无频谱（但仍有声音）

**回归**
- [ ] 现有朗读 / 音色库 / 考试页功能不变
- [ ] 语种切换后播放器状态正确复位（`Routes key={planKey}` 会重挂载）

---

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `Cannot find module '@waiyubaodian/hevc-player'` | SDK 未 build 或未 install；确认 `node_modules/@waiyubaodian/hevc-player/dist/index.d.ts` 存在 |
| 改了 SDK 源码主项目没生效 | 方式 A 需重新 `npm run build`；再 `npm run clean:cache` 清 Vite 缓存 |
| H265 视频黑屏 | 素材不是 HEVC 编码（H264 不支持）；或容器格式判错，显式传 `sourceKind: 'mp4'` / `container: 'mp4'` |
| 音频有声音但无频谱 | 音频跨域且未授权 CORS；设 `audioCrossOrigin: true` 并确认服务端返回 CORS 头 |
| Chrome 无用户手势不自动播 | 浏览器自动播放策略；改为用户点击后 `play()`，不要用 `autoPlay` |
| 主项目启动报 `NODE_MODULE_VERSION 137` | Node 版本错；所有命令加 `PATH=/usr/local/bin:$PATH` |
| 同屏两个播放器串台 | 用阶段 2 的全局单例方案；或换源时 `key={src}` / `stop()` |

---

## 7. 回滚

接入是**纯增量**的，回滚非常安全：

1. 删除新增的 `web/src/pages/MediaPlayerDemo.tsx`（及阶段 2 的 hook / 样式）；
2. 撤销 `App.tsx` / `Layout.tsx` 的路由与入口改动；
3. `npm uninstall @waiyubaodian/hevc-player`；
4. 删除测试素材 `web/public/media/`。

现有朗读 / 音色 / 考试代码一行未改，无需回滚。

---

## 8. 一句话交给新任务

> 先用 `npm install file:<SDK路径>` 把 `@waiyubaodian/hevc-player@0.2` 接进来，按本文 3.3 新建独立演示页跑通「H265 视频 + 纯音频频谱」两条路径，再按阶段 2 做全局单例避免串台；全程不动现有 `useVoicePlayer / useSpeech / useVoiceSystem`，所有主项目命令记得加 `PATH=/usr/local/bin:$PATH`。
