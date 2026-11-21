import type { MediaSource, ChunkResult } from './types';

/** 本地文件数据源（File / Blob）；供点播与本地测试。 */
export class FileSource implements MediaSource {
  private offset = 0;
  private aborted = false;
  private readonly chunkSize: number;

  constructor(
    private readonly file: Blob,
    chunkSize = 256 * 1024,
  ) {
    this.chunkSize = chunkSize;
  }

  get finite(): boolean {
    return true;
  }
  get totalBytes(): number {
    return this.file.size;
  }

  async next(): Promise<ChunkResult> {
    if (this.aborted || this.offset >= this.file.size) return { done: true };
    const end = Math.min(this.offset + this.chunkSize, this.file.size);
    const blob = this.file.slice(this.offset, end);
    const ab = await blob.arrayBuffer();
    this.offset = end;
    return { done: false, value: new Uint8Array(ab) };
  }

  async readRange(start: number, end: number): Promise<Uint8Array> {
    const blob = this.file.slice(start, end);
    return new Uint8Array(await blob.arrayBuffer());
  }

  abort(): void {
    this.aborted = true;
  }
}
