import { forwardRef, useImperativeHandle, useEffect, useRef } from 'react';
import type {
  MediaLoadOptions,
  MediaInfo,
  MediaPlayerOptions,
  MediaType,
  PlayerErrorInfo,
  PlayerState,
  PlayerStats,
} from '../types';
import { useMediaPlayer, type UseMediaPlayerResult } from './useMediaPlayer';

export interface MediaPlayerViewProps extends Omit<MediaPlayerOptions, 'canvas'> {
  /** 媒体地址；传入即自动 load */
  src?: string | Blob;
  /** 传给 load 的额外参数 */
  loadOptions?: Partial<MediaLoadOptions>;
  /** src 存在时是否自动播放，默认 true */
  autoPlay?: boolean;
  canvasStyle?: React.CSSProperties;
  className?: string;
  onStateChange?: (state: PlayerState) => void;
  onError?: (error: PlayerErrorInfo) => void;
  onReady?: (info: MediaInfo) => void;
  onMediaTypeChange?: (type: MediaType | null) => void;
}

export interface MediaPlayerHandle {
  load: (options: MediaLoadOptions) => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (us: number) => Promise<void>;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  getStats: () => PlayerStats | null;
  getMediaType: () => MediaType | null;
  getSpectrum: () => Uint8Array | null;
}

/**
 * MediaPlayerView —— 一套 UI 兼容纯音频 / 视频
 * 只挂载 canvas 与生命周期，控制栏交给宿主，保持零样式侵入。
 */
export const MediaPlayerView = forwardRef<MediaPlayerHandle, MediaPlayerViewProps>(
  function MediaPlayerView(
    { src, loadOptions, autoPlay = true, canvasStyle, className, onStateChange, onError, onReady, onMediaTypeChange, ...rest },
    ref,
  ) {
    const ctrl = useMediaPlayer(rest);
    const { canvasRef, player, state, error, info, mediaType } = ctrl;
    const lastSrc = useRef<string | Blob | undefined>(undefined);
    const loadOptionsKey = JSON.stringify(loadOptions && { ...loadOptions, url: '' });

    useEffect(() => {
      if (!src || !player || lastSrc.current === src) return;
      lastSrc.current = src;
      void ctrl
        .load({ url: src, ...loadOptions })
        .then(() => {
          if (autoPlay) player.play();
        })
        .catch(() => undefined);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, player, autoPlay, loadOptionsKey, ctrl.load]);

    useEffect(() => {
      onStateChange?.(state);
    }, [state, onStateChange]);
    useEffect(() => {
      if (error) onError?.(error);
    }, [error, onError]);
    useEffect(() => {
      if (info) onReady?.(info);
    }, [info, onReady]);
    useEffect(() => {
      onMediaTypeChange?.(mediaType);
    }, [mediaType, onMediaTypeChange]);

    useImperativeHandle(
      ref,
      () => ({
        load: ctrl.load,
        play: ctrl.play,
        pause: ctrl.pause,
        stop: ctrl.stop,
        seek: ctrl.seek,
        setRate: ctrl.setRate,
        setVolume: ctrl.setVolume,
        setMuted: ctrl.setMuted,
        getStats: () => (player ? player.getStats() : null),
        getMediaType: () => (player ? player.mediaType : null),
        getSpectrum: ctrl.getSpectrum,
      }),
      [ctrl, player],
    );

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{ display: 'block', maxWidth: '100%', background: '#0b1020', ...canvasStyle }}
      />
    );
  },
);

export type { UseMediaPlayerResult };
