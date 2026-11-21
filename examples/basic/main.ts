import { MediaPlayer } from '../../src/index';
import type { MediaType, SourceKind } from '../../src/index';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('screen') as HTMLCanvasElement;

let player: MediaPlayer | null = null;
let currentTab: MediaType = 'video';

function setBadge(state: string) {
  const el = $('state');
  el.textContent = state;
  el.className = 'badge ' + (state === 'error' ? 'error' : state === 'playing' ? 'playing' : '');
}

function showError(msg: string) {
  const el = $('err');
  el.style.display = 'block';
  el.textContent = msg;
}

function setTypeBadge(type: MediaType | null) {
  const el = $('typename');
  el.textContent = type === 'audio' ? '纯音频 · 频谱' : type === 'video' ? '视频 · H265' : '-';
  el.className = 'badge ' + (type === 'audio' ? 'audio' : '');
}

function initPlayer() {
  if (player) return player;
  player = new MediaPlayer({
    canvas,
    logLevel: 'warn',
    audio: { barCount: 64, fftSize: 2048 },
  });
  player.on('statechange', ({ to }) => setBadge(to));
  player.on('ready', (info) => {
    $('res').textContent = info.mediaType === 'audio' ? '音频 (无画面)' : `${info.width}x${info.height}`;
  });
  player.on('error', (err) => showError(`[${err.code}] ${err.message}`));
  setTypeBadge(player.mediaType);
  return player;
}

function enableControls(on: boolean) {
  ($('play') as HTMLButtonElement).disabled = !on;
  ($('pause') as HTMLButtonElement).disabled = !on;
  ($('stop') as HTMLButtonElement).disabled = !on;
}

async function doLoad(url: string, type: MediaType | 'auto', kind: SourceKind) {
  const p = initPlayer();
  $('err').style.display = 'none';
  setBadge('loading');
  try {
    await p.load({ url, mediaType: type, sourceKind: kind });
    enableControls(true);
    setTypeBadge(p.mediaType);
    p.setVolume(Number(($('volume') as HTMLInputElement).value) / 100);
    p.play();
  } catch (e) {
    showError(String(e));
  }
}

function selectTab(tab: MediaType) {
  currentTab = tab;
  $('tab-video').classList.toggle('active', tab === 'video');
  $('tab-audio').classList.toggle('active', tab === 'audio');
  ($('url') as HTMLInputElement).value = tab === 'audio' ? '/test-audio.wav' : '/test-hevc.mp4';
  ($('kind') as HTMLSelectElement).value = tab === 'audio' ? 'url' : 'mp4';
  ($('mtype') as HTMLSelectElement).value = tab === 'audio' ? 'audio' : 'video';
  ($('volume') as HTMLInputElement).disabled = tab !== 'audio';
  $('res').textContent = '-';
  enableControls(false);
}

$('tab-video').addEventListener('click', () => selectTab('video'));
$('tab-audio').addEventListener('click', () => selectTab('audio'));

$('load').addEventListener('click', async () => {
  const url = ($('url') as HTMLInputElement).value;
  const type = ($('mtype') as HTMLSelectElement).value as MediaType | 'auto';
  const kind = ($('kind') as HTMLSelectElement).value as SourceKind;
  await doLoad(url, type, kind);
});

$('play').addEventListener('click', () => player?.play());
$('pause').addEventListener('click', () => player?.pause());
$('stop').addEventListener('click', () => {
  player?.stop();
  enableControls(false);
});

$('volume').addEventListener('input', () => {
  const v = Number(($('volume') as HTMLInputElement).value);
  $('vol-label').textContent = v + '%';
  $('volval').textContent = v + '%';
  player?.setVolume(v / 100);
});

// 统计轮询
setInterval(() => {
  if (!player) return;
  const s = player.getStats();
  $('decoded').textContent = String(s.decodedFrames);
  $('dropped').textContent = String(s.droppedFrames);
  $('buffered').textContent = String(s.bufferedFrames);
  $('fps').textContent = String(s.decodeFps);
  $('pos').textContent = (s.positionUs / 1_000_000).toFixed(1);
  $('energy').textContent = (s.energy ?? 0).toFixed(2);
}, 400);

// 供无头冒烟测试读取
(window as unknown as { __mediaStats: () => unknown }).__mediaStats = () =>
  player
    ? { ...player.getStats(), state: player.state, mediaType: player.mediaType, info: player.info }
    : { state: 'idle' };

Object.defineProperty(window, '__mediaCtrl', { get: () => player, configurable: true });

// 兼容旧冒烟测试接口
(window as unknown as { __h265Stats: () => unknown }).__h265Stats = () =>
  player ? { ...player.getStats(), state: player.state, info: player.info } : { state: 'idle' };
(window as unknown as { __h265Ctrl: MediaPlayer | null }).__h265Ctrl = null;
Object.defineProperty(window, '__h265Ctrl', { get: () => player, configurable: true });

(window as unknown as { __mediaLoad: (url: string, type: MediaType | 'auto', kind: SourceKind) => Promise<void> }).__mediaLoad =
  async (url, type = 'auto', kind = 'url') => {
    await doLoad(url, type, kind);
  };
(window as unknown as { __h265Load: (url: string, kind: SourceKind) => Promise<void> }).__h265Load =
  async (url, kind = 'url') => {
    await doLoad(url, 'video', kind);
  };

// 初始化默认 tab（不自动加载，等用户点或冒烟脚本触发）
selectTab('video');
void currentTab;
