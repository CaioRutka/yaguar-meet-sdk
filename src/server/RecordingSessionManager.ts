import { randomBytes } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';

type SessionState = {
  filePath: string;
  mimeType: string;
  stream: WriteStream;
};

function safeKeySegment(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

/**
 * Appends audio chunks to a temp file per meeting (or room) for server-side processing.
 * Avoids holding the full recording in RAM.
 */
export class RecordingSessionManager {
  private readonly tmpDir: string;
  private sessions = new Map<string, SessionState>();
  private ensuredMkdir = false;

  /**
   * @param tmpDir - Directory for temp files (default: `os.tmpdir()`).
   */
  constructor(tmpDir?: string) {
    this.tmpDir = tmpDir?.trim() || os.tmpdir();
  }

  private async ensureTmpDir(): Promise<void> {
    if (this.ensuredMkdir) return;
    await mkdir(this.tmpDir, { recursive: true });
    this.ensuredMkdir = true;
  }

  async start(key: string, mimeType: string): Promise<void> {
    await this.ensureTmpDir();

    const existing = this.sessions.get(key);
    if (existing) {
      await this.closeSessionDiscard(existing);
      this.sessions.delete(key);
    }

    const fileName = `yaguar-meet-${safeKeySegment(key)}-${randomBytes(8).toString('hex')}.webm`;
    const filePath = path.join(this.tmpDir, fileName);
    const stream = createWriteStream(filePath, { flags: 'w' });
    const mime = mimeType?.trim() || 'audio/webm';

    this.sessions.set(key, { filePath, mimeType: mime, stream });
  }

  appendChunk(key: string, data: Buffer): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.stream.write(data);
  }

  /**
   * Finalizes the file and returns its path for upload/transcription.
   * Deletes empty files and returns null.
   */
  async stop(key: string): Promise<{ filePath: string; mimeType: string } | null> {
    const s = this.sessions.get(key);
    if (!s) return null;
    this.sessions.delete(key);

    const { filePath, mimeType, stream } = s;

    try {
      stream.end();
      await finished(stream);
    } catch (e) {
      await unlink(filePath).catch(() => {});
      throw e;
    }

    try {
      const st = await stat(filePath);
      if (st.size === 0) {
        await unlink(filePath).catch(() => {});
        return null;
      }
    } catch {
      return null;
    }

    return { filePath, mimeType };
  }

  hasSession(key: string): boolean {
    return this.sessions.has(key);
  }

  private async closeSessionDiscard(s: SessionState): Promise<void> {
    try {
      s.stream.destroy();
    } catch {
      /* ignore */
    }
    await unlink(s.filePath).catch(() => {});
  }
}
