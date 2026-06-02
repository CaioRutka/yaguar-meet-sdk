import { randomBytes } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';

type SessionState = {
  filePath: string;
  mimeType: string;
  startedAt: number;
  stream: WriteStream;
};

export type RecordingSegment = {
  filePath: string;
  mimeType: string;
  /** Server-side epoch ms when this segment started (used to interleave speakers). */
  startedAt: number;
  /** Display name of the participant who produced this audio. */
  speaker: string;
  /** Stable identity of the speaker (meet user id or socket id). */
  speakerId: string;
};

/** Identity/config for a participant's recording stream. */
export interface StartRecordingOptions {
  /** Unique key for this participant within the meeting (typically the socket id). */
  participantKey: string;
  /** Display name used as the speaker label in the transcript. */
  speaker: string;
  /** Stable identity of the speaker. */
  speakerId: string;
  /** Audio mime type (default `audio/webm`). */
  mimeType?: string;
}

type ParticipantRecording = {
  speaker: string;
  speakerId: string;
  segments: RecordingSegment[];
  active: SessionState | null;
};

function safeKeySegment(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

/**
 * Appends audio chunks to temp files for server-side processing.
 *
 * Each meeting holds one recording per participant (keyed by `participantKey`),
 * so the AI pipeline can transcribe every microphone separately and attribute
 * each line to who spoke it. Pause/resume creates multiple segments per
 * participant.
 */
export class RecordingSessionManager {
  private readonly tmpDir: string;
  /** meetingKey → participantKey → recording */
  private meetings = new Map<string, Map<string, ParticipantRecording>>();
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

  private getOrCreateMeeting(key: string): Map<string, ParticipantRecording> {
    let meeting = this.meetings.get(key);
    if (!meeting) {
      meeting = new Map();
      this.meetings.set(key, meeting);
    }
    return meeting;
  }

  private getOrCreateParticipant(
    key: string,
    opts: { participantKey: string; speaker: string; speakerId: string }
  ): ParticipantRecording {
    const meeting = this.getOrCreateMeeting(key);
    let participant = meeting.get(opts.participantKey);
    if (!participant) {
      participant = { speaker: opts.speaker, speakerId: opts.speakerId, segments: [], active: null };
      meeting.set(opts.participantKey, participant);
    } else {
      // Refresh identity in case the display name changed mid-meeting.
      participant.speaker = opts.speaker;
      participant.speakerId = opts.speakerId;
    }
    return participant;
  }

  /** Starts a new recording segment for a participant (finalizes any active one first). */
  async start(key: string, opts: StartRecordingOptions): Promise<void> {
    await this.ensureTmpDir();
    await this.finalizeActive(key, opts.participantKey);

    const fileName = `yaguar-meet-${safeKeySegment(key)}-${safeKeySegment(opts.participantKey)}-${randomBytes(6).toString('hex')}.webm`;
    const filePath = path.join(this.tmpDir, fileName);
    const stream = createWriteStream(filePath, { flags: 'w' });
    const mime = opts.mimeType?.trim() || 'audio/webm';

    const participant = this.getOrCreateParticipant(key, opts);
    participant.active = { filePath, mimeType: mime, startedAt: Date.now(), stream };
  }

  appendChunk(key: string, participantKey: string, data: Buffer): void {
    const active = this.meetings.get(key)?.get(participantKey)?.active;
    if (!active) return;
    active.stream.write(data);
  }

  /** Finalizes a participant's active segment without ending the meeting recording. */
  async pauseParticipant(key: string, participantKey: string): Promise<void> {
    await this.finalizeActive(key, participantKey);
  }

  /**
   * Finalizes every participant's active segment and returns all segments
   * (across participants), ordered by start time, for transcription.
   * Deletes empty files. Returns null when no audio was captured.
   */
  async stop(key: string): Promise<{ segments: RecordingSegment[] } | null> {
    const meeting = this.meetings.get(key);
    if (!meeting) return null;

    for (const participantKey of meeting.keys()) {
      await this.finalizeActive(key, participantKey);
    }

    const segments: RecordingSegment[] = [];
    for (const participant of meeting.values()) {
      segments.push(...participant.segments);
    }
    this.meetings.delete(key);

    if (segments.length === 0) return null;
    segments.sort((a, b) => a.startedAt - b.startedAt);
    return { segments };
  }

  hasSession(key: string): boolean {
    const meeting = this.meetings.get(key);
    if (!meeting) return false;
    for (const p of meeting.values()) {
      if (p.active || p.segments.length > 0) return true;
    }
    return false;
  }

  hasActiveParticipant(key: string, participantKey: string): boolean {
    return Boolean(this.meetings.get(key)?.get(participantKey)?.active);
  }

  private async finalizeActive(key: string, participantKey: string): Promise<void> {
    const participant = this.meetings.get(key)?.get(participantKey);
    const active = participant?.active;
    if (!participant || !active) return;

    participant.active = null;
    const { filePath, mimeType, startedAt, stream } = active;

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
      participant.segments.push({
        filePath,
        mimeType,
        startedAt,
        speaker: participant.speaker,
        speakerId: participant.speakerId,
      });
    } catch {
      await unlink(filePath).catch(() => {});
    }
  }
}
