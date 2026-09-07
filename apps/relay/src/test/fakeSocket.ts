import type { SpliceSocket } from "../splicePair";

export class FakeSocket implements SpliceSocket {
  bufferedAmount = 0;
  paused = false;
  sent: Array<{ data: Buffer; binary: boolean }> = [];
  closes: Array<{ code: number; reason: string }> = [];
  private readonly messageListeners = new Set<(data: Buffer, binary: boolean) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private readonly drainListeners = new Set<() => void>();

  send(data: Buffer, binary: boolean): void {
    this.sent.push({ data, binary });
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  pauseReads(): void {
    this.paused = true;
  }

  resumeReads(): void {
    this.paused = false;
  }

  onMessage(listener: (data: Buffer, binary: boolean) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  emitMessage(data: Buffer, binary: boolean): void {
    if (this.paused) return;
    for (const listener of this.messageListeners) listener(data, binary);
  }

  emitJson(value: unknown): void {
    this.emitMessage(Buffer.from(JSON.stringify(value)), false);
  }

  emitClose(code: number, reason = ""): void {
    for (const listener of this.closeListeners) listener(code, reason);
  }

  emitDrain(): void {
    for (const listener of this.drainListeners) listener();
  }

  sentJson(): unknown[] {
    return this.sent
      .filter((frame) => !frame.binary)
      .map((frame) => JSON.parse(frame.data.toString("utf8")) as unknown);
  }
}
