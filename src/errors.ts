import type { ErrorCode } from './types';

/**
 * 类型化错误体系
 * ------------------------------------------------------------------
 * 所有对外抛出的错误都是 PlayerError，调用方只需按 code 分支，
 * 不依赖脆弱的 message 文案。内部错误（WASM/Worker 抛出）统一在此
 * 归一化，绝不把堆栈或内部细节泄漏给 UI。
 */
export class PlayerError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;
  /** 是否可恢复（例如网络抖动），供 UI 决定是否重试。 */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message);
    this.name = 'PlayerError';
    this.code = code;
    this.cause = options?.cause;
    this.retryable = options?.retryable ?? false;
    // 维护原型链（ES2022 target 下通常已正确，显式设置更稳妥）
    Object.setPrototypeOf(this, PlayerError.prototype);
  }

  /** 面向最终用户的可读中文文案（屏蔽技术细节） */
  get userMessage(): string {
    switch (this.code) {
      case 'INVALID_OPTION':
        return '播放器配置有误，请检查初始化参数。';
      case 'UNSUPPORTED':
        return '当前浏览器不支持 H.265 播放所需的特性。';
      case 'NETWORK':
        return '网络连接失败，请检查网络后重试。';
      case 'HTTP_STATUS':
        return '视频资源加载失败，请确认地址是否正确。';
      case 'DEMUX':
        return '视频格式解析失败，请确认文件为 H.265 编码。';
      case 'DECODE':
        return '视频解码失败，请尝试降低分辨率或刷新重试。';
      case 'TIMEOUT':
        return '加载超时，请稍后重试。';
      case 'ABORTED':
        return '播放已停止。';
      case 'STATE':
        return '播放器状态异常，请重新加载。';
      case 'RENDER':
        return '画面渲染失败，请刷新页面重试。';
      default:
        return '播放器发生未知错误。';
    }
  }

  /** 是否为正常的主动中止，不算故障 */
  get isAbort(): boolean {
    return this.code === 'ABORTED';
  }

  static fromUnknown(err: unknown, fallbackCode: ErrorCode = 'DECODE'): PlayerError {
    if (err instanceof PlayerError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PlayerError(fallbackCode, message, { cause: err });
  }
}

/** 便捷构造函数 */
export const playerError = {
  invalidOption: (msg: string) => new PlayerError('INVALID_OPTION', msg),
  unsupported: (msg: string) => new PlayerError('UNSUPPORTED', msg),
  network: (msg: string, cause?: unknown) =>
    new PlayerError('NETWORK', msg, { cause, retryable: true }),
  http: (status: number, url: string) =>
    new PlayerError('HTTP_STATUS', `HTTP ${status} while loading ${url}`, {
      retryable: status >= 500 || status === 429,
    }),
  demux: (msg: string, cause?: unknown) => new PlayerError('DEMUX', msg, { cause }),
  decode: (msg: string, cause?: unknown) => new PlayerError('DECODE', msg, { cause }),
  timeout: (msg: string) => new PlayerError('TIMEOUT', msg, { retryable: true }),
  aborted: () => new PlayerError('ABORTED', 'Operation aborted'),
  state: (msg: string) => new PlayerError('STATE', msg),
  render: (msg: string, cause?: unknown) => new PlayerError('RENDER', msg, { cause }),
};
