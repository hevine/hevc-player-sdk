/**
 * 数据源层公共契约
 * ------------------------------------------------------------------
 * 把"字节从哪来"（fetch / WebSocket / 本地 File）抽象为统一的拉取器。
 * 采用异步迭代风格：调用方 await next() 拿下一块，天然支持背压
 * （不 next 就不拉取，配合解码器的 awaitDrain 形成端到端流控）。
 */
export interface ChunkResult {
  done: boolean;
  value?: Uint8Array;
}

export interface MediaSource {
  /** 拉取下一块数据 */
  next(): Promise<ChunkResult>;
  /** 主动终止（stop / destroy / seek 换源） */
  abort(): void;
  /** 是否为有限流（点播文件 true，直播 false） */
  readonly finite: boolean;
  /** 可选：HTTP 响应头里解析出的内容类型，用于容器探测 */
  readonly contentType?: string;
  /** 可选：可 seek 的字节范围读取（点播） */
  readRange?(start: number, end: number): Promise<Uint8Array>;
  /** 可选：总字节数 */
  readonly totalBytes?: number;
}
