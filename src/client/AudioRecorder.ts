/**
 * Captures local microphone audio via `MediaRecorder` and forwards base64 chunks
 * through the signaling channel to the server-side `RecordingSessionManager`.
 */
import { TypedEmitter } from './typedEmitter';
import type { SignalingClient } from './SignalingClient';

export interface AudioRecorderEvents extends Record<string, unknown> {
  start: { mimeType: string };
  stop: void;
  error: { error: unknown };
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const c of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class AudioRecorder extends TypedEmitter<AudioRecorderEvents> {
  private recorder: MediaRecorder | null = null;
  private _isRecording = false;

  constructor(
    private readonly signaling: SignalingClient,
    private readonly options: { roomId: string; chunkIntervalMs?: number }
  ) {
    super();
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  start(localStream: MediaStream): boolean {
    if (this._isRecording) return false;
    const audioTracks = localStream.getAudioTracks().filter((t) => t.readyState === 'live');
    if (audioTracks.length === 0) return false;

    const mimeType = pickMimeType();
    const stream = new MediaStream(audioTracks);

    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (error) {
      this.emit('error', { error });
      return false;
    }

    rec.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      void ev.data.arrayBuffer().then((buf) => {
        this.signaling.appendRecordingChunk(this.options.roomId, bufferToBase64(buf));
      });
    };

    rec.onerror = (ev: Event) => {
      this.emit('error', { error: ev });
    };

    const effectiveMime = rec.mimeType || mimeType || 'audio/webm';
    this.signaling.startRecording(this.options.roomId, effectiveMime);
    rec.start(this.options.chunkIntervalMs ?? 1000);
    this.recorder = rec;
    this._isRecording = true;
    this.emit('start', { mimeType: effectiveMime });
    return true;
  }

  stop(): void {
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    this.recorder = null;
    if (this._isRecording) {
      this._isRecording = false;
      this.signaling.stopRecording(this.options.roomId);
      this.emit('stop', undefined as void);
    }
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}
