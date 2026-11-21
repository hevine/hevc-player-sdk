import type { PlayerState } from '../types';
import { playerError } from '../errors';

/**
 * 播放状态机
 * ------------------------------------------------------------------
 * 显式合法迁移表，拒绝非法跃迁（例如 idle 直接 resume）。
 * 每次成功迁移由调用方广播 statechange 事件。
 */
const TRANSITIONS: Record<PlayerState, PlayerState[]> = {
  idle: ['loading', 'error'],
  loading: ['ready', 'error', 'idle'],
  ready: ['playing', 'seeking', 'loading', 'error', 'idle'],
  playing: ['paused', 'seeking', 'ready', 'ended', 'error', 'idle'],
  paused: ['playing', 'seeking', 'ready', 'idle', 'error'],
  seeking: ['playing', 'paused', 'ready', 'error', 'idle'],
  ended: ['loading', 'ready', 'idle', 'error'],
  error: ['loading', 'idle'],
};

export class StateMachine {
  private current: PlayerState = 'idle';
  private readonly onChange?: (from: PlayerState, to: PlayerState) => void;

  constructor(onChange?: (from: PlayerState, to: PlayerState) => void) {
    this.onChange = onChange;
  }

  get state(): PlayerState {
    return this.current;
  }

  can(next: PlayerState): boolean {
    if (next === this.current) return true;
    return TRANSITIONS[this.current].includes(next);
  }

  /** 尝试迁移；非法迁移抛 STATE 错误。force 用于错误/销毁路径强制复位。 */
  transition(next: PlayerState, force = false): PlayerState {
    if (next === this.current) return this.current;
    if (!force && !this.can(next)) {
      throw playerError.state(`Illegal transition: ${this.current} -> ${next}`);
    }
    const from = this.current;
    this.current = next;
    this.onChange?.(from, next);
    return next;
  }

  is(...states: PlayerState[]): boolean {
    return states.includes(this.current);
  }
}
