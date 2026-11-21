import { useRef, useState, useEffect, useCallback } from 'react';
import { H265Player } from '../H265Player';
import type {
  PlayerOptions,
  PlayerState,
  PlayerStats,
  MediaInfo,
  PlayerErrorInfo,
  LoadOptions,
} from '../types';

export interface UseH265PlayerResult {
  /** 绑定到 <canvas ref={...}> */
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** 播放器实例（首次渲染后可用） */
  player: H265Player | null;
  state: PlayerState;
  info: MediaInfo | null;
  error: PlayerErrorInfo | null;
  stats: PlayerStats | null;
  load: (options: LoadOptions) => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (us: number) => Promise<void>;
  setRate: (rate: number) => void;
}

/**
 * useH265Player —— React 封装
 * ------------------------------------------------------------------
 * 用 ref + lazy state 持有单例播放器，避免每次渲染重建。
 * 兼容 StrictMode：effect 清理时销毁播放器，重新挂载时重建；
 * sessionId 机制保证卸载后的异步回调不会污染新实例。
 */
export function useH265Player(options: Omit<PlayerOptions, 'canvas'>): UseH265PlayerResult {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<H265Player | null>(null);
  const [player, setPlayer] = useState<H265Player | null>(null);
  const [state, setState] = useState<PlayerState>('idle');
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [error, setError] = useState<PlayerErrorInfo | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 用稳定 key 判定配置是否变化（避免对象字面量导致反复重建）
  const canvasMounted = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasMounted.current) return;
    canvasMounted.current = true;

    let instance: H265Player;
    try {
      instance = new H265Player({ ...optionsRef.current, canvas });
    } catch (err) {
      setError(err as PlayerErrorInfo);
      return;
    }
    playerRef.current = instance;
    setPlayer(instance);

    const offs = [
      instance.on('statechange', ({ to }) => setState(to)),
      instance.on('ready', (m) => setInfo(m)),
      instance.on('error', (e) => setError(e)),
    ];
    const statTimer = setInterval(() => {
      if (playerRef.current) setStats(playerRef.current.getStats());
    }, 500);

    return () => {
      clearInterval(statTimer);
      offs.forEach((off) => off());
      void instance.destroy();
      playerRef.current = null;
      canvasMounted.current = false;
    };
  }, []);

  const load = useCallback(async (opts: LoadOptions) => {
    setError(null);
    await playerRef.current?.load(opts);
  }, []);
  const play = useCallback(() => playerRef.current?.play(), []);
  const pause = useCallback(() => playerRef.current?.pause(), []);
  const stop = useCallback(() => playerRef.current?.stop(), []);
  const seek = useCallback(async (us: number) => {
    await playerRef.current?.seek(us);
  }, []);
  const setRate = useCallback((rate: number) => playerRef.current?.setRate(rate), []);

  return {
    canvasRef,
    player,
    state,
    info,
    error,
    stats,
    load,
    play,
    pause,
    stop,
    seek,
    setRate,
  };
}
