import { forwardRef, useImperativeHandle, useEffect, useRef } from 'react';
import type { PlayerOptions, PlayerState, MediaInfo, PlayerStats, PlayerErrorInfo, LoadOptions } from '../types';
import { useH265Player, type UseH265PlayerResult } from './useH265Player';

export interface H265PlayerViewProps extends Omit<PlayerOptions, 'canvas'> {
  /** 媒体地址；传入即自动 load（autoPlay 时同时播放） */
  src?: string;
  /** 传给 load 的额外参数 */
  loadOptions?: Partial<LoadOptions>;
  /** src 存在时是否自动播放，默认 true */
  autoPlay?: boolean;
  canvasStyle?: React.CSSProperties;
  className?: string;
  onStateChange?: (state: PlayerState) => void;
  onError?: (error: PlayerErrorInfo) => void;
  onReady?: (info: MediaInfo) => void;
}

/** 通过 ref 暴露的控制句柄 */
export interface H265PlayerHandle {
  load: (options: LoadOptions) => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (us: number) => Promise<void>;
  setRate: (rate: number) => void;
  getStats: () => PlayerStats | null;
}

/**
 * H265PlayerView —— 开箱即用的 React 组件
 * ------------------------------------------------------------------
 * 只负责挂载 <canvas> 与生命周期；控制栏 UI 交给宿主（SDK 不绑定样式）。
 * 通过 ref 暴露播放控制，属性回调暴露状态，保持零样式侵入。
 */
export const H265PlayerView = forwardRef<H265PlayerHandle, H265PlayerViewProps>(
  function H265PlayerView(
    { src, loadOptions, autoPlay = true, canvasStyle, className, onStateChange, onError, onReady, ...rest },
    ref,
  ) {
    const ctrl = useH265Player(rest);
    const { canvasRef, player, state, error, info } = ctrl;
    const lastSrc = useRef<string | undefined>(undefined);
    const loadOptionsKey = JSON.stringify(loadOptions ?? {});

    // src 变化时加载一次
    useEffect(() => {
      if (!src || !player || lastSrc.current === src) return;
      lastSrc.current = src;
      void ctrl
        .load({ url: src, ...loadOptions })
        .then(() => {
          if (autoPlay) player.play();
        })
        .catch(() => undefined);
      // loadOptionsKey 参与依赖以覆盖显式变更
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, player, autoPlay, loadOptionsKey, ctrl.load]);

    // 向上同步状态
    useEffect(() => {
      onStateChange?.(state);
    }, [state, onStateChange]);
    useEffect(() => {
      if (error) onError?.(error);
    }, [error, onError]);
    useEffect(() => {
      if (info) onReady?.(info);
    }, [info, onReady]);

    useImperativeHandle(
      ref,
      () => ({
        load: ctrl.load,
        play: ctrl.play,
        pause: ctrl.pause,
        stop: ctrl.stop,
        seek: ctrl.seek,
        setRate: ctrl.setRate,
        getStats: () => (player ? player.getStats() : null),
      }),
      [ctrl, player],
    );

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{ display: 'block', maxWidth: '100%', background: '#000', ...canvasStyle }}
      />
    );
  },
);
