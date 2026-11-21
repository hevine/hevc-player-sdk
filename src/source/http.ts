import type { MediaSource, ChunkResult } from './types';
import { playerError } from '../errors';

/**
 * HTTP(Fetch) 数据源
 * ------------------------------------------------------------------
 * 用 fetch + ReadableStream 读取，支持 AbortController 取消。
 * HTTP 非 2xx 归一化到 HTTP_STATUS 错误（401/403/404 不重试，5xx/429 可重试）。
 * 暴露 readRange 供 MP4 seek（Range 请求）。
 */
export class HttpSource implements MediaSource {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly abortController = new AbortController();
  private aborted = false;
  private readonly timeoutTimer: ReturnType<typeof setTimeout>;
  private initPromise: Promise<void> | null = null;
  private contentTypeValue: string | undefined;
  private totalBytesValue: number | undefined;

  constructor(
    private readonly url: string,
    private readonly opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
  ) {
    const timeoutMs = opts.timeoutMs ?? 15000;
    this.timeoutTimer = setTimeout(() => {
      if (!this.aborted) this.abortController.abort();
    }, timeoutMs);
    void this.init();
  }

  get finite(): boolean {
    return true;
  }
  get contentType(): string | undefined {
    return this.contentTypeValue;
  }
  get totalBytes(): number | undefined {
    return this.totalBytesValue;
  }

  private init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const res = await fetch(this.url, {
        headers: this.opts.headers,
        signal: this.abortController.signal,
      });
      if (!res.ok) throw playerError.http(res.status, this.url);
      this.contentTypeValue = res.headers.get('content-type') ?? undefined;
      const len = res.headers.get('content-length');
      this.totalBytesValue = len ? Number(len) : undefined;
      if (!res.body) throw playerError.network('响应体为空', undefined);
      this.reader = res.body.getReader();
    })();
    return this.initPromise;
  }

  async next(): Promise<ChunkResult> {
    if (this.aborted) return { done: true };
    await this.init();
    if (!this.reader) return { done: true };
    try {
      const { done, value } = await this.reader.read();
      if (done) return { done: true };
      return { done: false, value };
    } catch (err) {
      if (this.aborted) return { done: true };
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError') return { done: true };
      throw playerError.network(`读取失败: ${String(err)}`, err);
    }
  }

  async readRange(start: number, end: number): Promise<Uint8Array> {
    if (this.aborted) throw playerError.aborted();
    const res = await fetch(this.url, {
      headers: { ...(this.opts.headers ?? {}), Range: `bytes=${start}-${end - 1}` },
    });
    if (!res.ok && res.status !== 206) throw playerError.http(res.status, this.url);
    return new Uint8Array(await res.arrayBuffer());
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortController.abort();
    clearTimeout(this.timeoutTimer);
    try {
      void this.reader?.cancel().catch(() => undefined);
    } catch {
      /* ignore */
    }
    this.reader = null;
  }
}
