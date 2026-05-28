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

export type RecordingSegment = {
  filePath: string;
  mimeType: string;
};

type MeetingRecording = {
  segments: RecordingSegment[];
  active: SessionState | null;
};

function safeKeySegment(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

/**
 * Appends audio chunks to temp files per meeting (or room) for server-side processing.
 * Supports multiple segments when the host pauses and resumes recording.
 */
export class RecordingSessionManager {
  private readonly tmpDir: string;
  private meetings = new Map<string, MeetingRecording>();
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

  private getOrCreateMeeting(key: string): MeetingRecording {
    let meeting = this.meetings.get(key);
    if (!meeting) {
      meeting = { segments: [], active: null };
      this.meetings.set(key, meeting);
    }
    return meeting;
  }

  /** Starts a new recording segment (finalizes any active segment first). */
  async start(key: string, mimeType: string): Promise<void> {
    await this.ensureTmpDir();
    await this.finalizeActive(key);

    const fileName = `yaguar-meet-${safeKeySegment(key)}-${randomBytes(8).toString('hex')}.webm`;
    const filePath = path.join(this.tmpDir, fileName);
    const stream = createWriteStream(filePath, { flags: 'w' });
    const mime = mimeType?.trim() || 'audio/webm';

    const meeting = this.getOrCreateMeeting(key);
    meeting.active = { filePath, mimeType: mime, stream };
  }

  appendChunk(key: string, data: Buffer): void {
    const meeting = this.meetings.get(key);
    const active = meeting?.active;
    if (!active) return;
    active.stream.write(data);
  }

  /** Finalizes the active segment without ending the meeting recording. */
  async pause(key: string): Promise<void> {
    await this.finalizeActive(key);
  }

  /**
   * Finalizes any active segment and returns all segments for upload/transcription.
   * Deletes empty files. Returns null when no audio was captured.
   */
  async stop(key: string): Promise<{ segments: RecordingSegment[] } | null> {
    await this.finalizeActive(key);
    const meeting = this.meetings.get(key);
    if (!meeting || meeting.segments.length === 0) {
      this.meetings.delete(key);
      return null;
    }
    const segments = [...meeting.segments];
    this.meetings.delete(key);
    return { segments };
  }

  hasSession(key: string): boolean {
    const meeting = this.meetings.get(key);
    return Boolean(meeting?.active || (meeting?.segments.length ?? 0) > 0);
  }

  private async finalizeActive(key: string): Promise<void> {
    const meeting = this.meetings.get(key);
    const active = meeting?.active;
    if (!active) return;

    meeting!.active = null;
    const { filePath, mimeType, stream } = active;

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
        return;
      }
      meeting!.segments.push({ filePath, mimeType });
    } catch {
      await unlink(filePath).catch(() => {});
    }
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
