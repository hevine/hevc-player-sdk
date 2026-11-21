import type { EventHandler, PlayerEvents } from '../types';

/**
 * 类型安全的事件发射器
 * ------------------------------------------------------------------
 * on 返回取消订阅函数；emit 时同步快照监听器数组，避免回调中增删
 * 导致遍历异常；单个监听器抛错隔离，不影响其它监听器与播放器主流程。
 */
export class EventEmitter {
  private readonly handlers = new Map<keyof PlayerEvents, Set<EventHandler<never>>>();

  on<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler<never>);
    return () => this.off(event, handler);
  }

  once<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): () => void {
    const off = this.on(event, ((payload: PlayerEvents[K]) => {
      off();
      handler(payload);
    }) as EventHandler<K>);
    return off;
  }

  off<K extends keyof PlayerEvents>(event: K, handler: EventHandler<K>): void {
    this.handlers.get(event)?.delete(handler as EventHandler<never>);
  }

  emit<K extends keyof PlayerEvents>(event: K, payload: PlayerEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as EventHandler<K>)(payload);
      } catch {
        // 监听器异常隔离：不冒泡、不中断其它监听器
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
