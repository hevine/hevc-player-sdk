import { useRef, useState, useEffect, useCallback } from 'react';
import { MediaPlayer } from '../MediaPlayer';
import type {
  MediaLoadOptions,
  MediaInfo,
  MediaPlayerOptions,
  MediaType,
  PlayerErrorInfo,
  PlayerState,
  PlayerStats,
} from '../types';

export interface UseMediaPlayerResult {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  player: MediaPlayer | null;
  state: PlayerState;
  info: MediaInfo | null;
  mediaType: MediaType | null;
  error: PlayerErrorInfo | null;
  stats: PlayerStats | null;
  load: (options: MediaLoadOptions) => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (us: number) => Promise<void>;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  getSpectrum: () => Uint8Array | null;
}

/** useMediaPlayer —— 统一播放器 React hook（音频 / 视频一套 API） */
export function useMediaPlayer(options: Omit<MediaPlayerOptions, 'canvas'>): UseMediaPlayerResult {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<MediaPlayer | null>(null);
  const [player, setPlayer] = useState<MediaPlayer | null>(null);
  const [state, setState] = useState<PlayerState>('idle');
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [mediaType, setMediaType] = useState<MediaType | null>(null);
  const [error, setError] = useState<PlayerErrorInfo | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const canvasMounted = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasMounted.current) return;
    canvasMounted.current = true;

    let instance: MediaPlayer;
    try {
      instance = new MediaPlayer({ ...optionsRef.current, canvas });
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
      const p = playerRef.current;
      if (!p) return;
      setStats(p.getStats());
      setMediaType(p.mediaType);
    }, 400);

    return () => {
      clearInterval(statTimer);
      offs.forEach((off) => off());
      void instance.destroy();
      playerRef.current = null;
      canvasMounted.current = false;
    };
  }, []);

  const load = useCallback(async (opts: MediaLoadOptions) => {
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
  const setVolume = useCallback((volume: number) => playerRef.current?.setVolume(volume), []);
  const setMuted = useCallback((muted: boolean) => playerRef.current?.setMuted(muted), []);
  const getSpectrum = useCallback(() => playerRef.current?.getSpectrum() ?? null, []);

  return {
    canvasRef,
    player,
    state,
    info,
    mediaType,
    error,
    stats,
    load,
    play,
    pause,
    stop,
    seek,
    setRate,
    setVolume,
    setMuted,
    getSpectrum,
  };
}
