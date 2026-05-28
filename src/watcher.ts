import { existsSync } from "node:fs";
import { stat, open } from "node:fs/promises";

const POLL_INTERVAL_MS = 500;

export type LineHandler = (line: string) => void | Promise<void>;

/**
 * Polls a JSONL file for new lines appended since the start of polling.
 * Cursor starts at current file size (no historical replay).
 * Survives file truncation and absent-then-created files.
 */
export class FilePoller {
  private cursor = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busy = false;

  constructor(private file: string, private onLine: LineHandler) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (existsSync(this.file)) {
      try {
        const s = await stat(this.file);
        this.cursor = s.size;
      } catch {
        this.cursor = 0;
      }
    } else {
      this.cursor = 0;
    }
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      if (!existsSync(this.file)) return;
      const s = await stat(this.file);
      if (s.size < this.cursor) this.cursor = 0; // file truncated/replaced
      if (s.size === this.cursor) return;
      const fh = await open(this.file, "r");
      try {
        const len = s.size - this.cursor;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, this.cursor);
        const chunk = buf.toString("utf8");
        const lines = chunk.split("\n");
        // Last element is the partial-line tail (empty if chunk ends with \n).
        const tail = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length === 0) continue;
          await this.onLine(line);
        }
        this.cursor = s.size - Buffer.byteLength(tail, "utf8");
      } finally {
        await fh.close();
      }
    } catch {
      // transient read errors are fine — next tick will retry
    } finally {
      this.busy = false;
    }
  }
}
