/**
 * Owns the local microphone/camera/screen streams.
 *
 * Wraps `getUserMedia` / `getDisplayMedia`, exposes mute/cam-off toggles, and
 * emits state-change events. Pure browser primitives, no React, no socket.
 */
import { TypedEmitter } from './typedEmitter';

export interface LocalMediaEvents extends Record<string, unknown> {
  'camera-stream': MediaStream | null;
  'screen-stream': MediaStream | null;
  'mic-muted': boolean;
  'cam-off': boolean;
  'screen-share-end': void;
  error: { kind: 'getUserMedia' | 'getDisplayMedia'; error: unknown };
}

export class LocalMedia extends TypedEmitter<LocalMediaEvents> {
  private _localStream: MediaStream | null = null;
  private _screenStream: MediaStream | null = null;
  private _isMicMuted = false;
  private _isCamOff = false;

  static canScreenShare(): boolean {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false;
    return typeof navigator.mediaDevices.getDisplayMedia === 'function';
  }

  get localStream(): MediaStream | null {
    return this._localStream;
  }

  get screenStream(): MediaStream | null {
    return this._screenStream;
  }

  get isMicMuted(): boolean {
    return this._isMicMuted;
  }

  get isCamOff(): boolean {
    return this._isCamOff;
  }

  get isScreenSharing(): boolean {
    return this._screenStream !== null;
  }

  /** Reuse an externally-acquired stream (e.g. from a lobby preview). */
  setStream(stream: MediaStream | null): void {
    if (this._localStream && this._localStream !== stream) {
      this._localStream.getTracks().forEach((t) => t.stop());
    }
    this._localStream = stream;
    if (stream) {
      const audio = stream.getAudioTracks()[0];
      const video = stream.getVideoTracks()[0];
      this._isMicMuted = audio ? !audio.enabled : false;
      this._isCamOff = video ? !video.enabled : false;
    }
    this.emit('camera-stream', stream);
  }

  async startCamera(
    constraints: MediaStreamConstraints = { audio: true, video: true }
  ): Promise<MediaStream | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.setStream(stream);
      return stream;
    } catch (error) {
      this.emit('error', { kind: 'getUserMedia', error });
      return null;
    }
  }

  toggleMic(): void {
    if (!this._localStream) return;
    const tracks = this._localStream.getAudioTracks();
    if (tracks.length === 0) return;
    tracks.forEach((t) => {
      t.enabled = !t.enabled;
    });
    this._isMicMuted = !(tracks[0] as MediaStreamTrack).enabled;
    this.emit('mic-muted', this._isMicMuted);
  }

  toggleCam(): void {
    if (!this._localStream) return;
    const tracks = this._localStream.getVideoTracks();
    if (tracks.length === 0) return;
    tracks.forEach((t) => {
      t.enabled = !t.enabled;
    });
    this._isCamOff = !(tracks[0] as MediaStreamTrack).enabled;
    this.emit('cam-off', this._isCamOff);
  }

  async startScreenShare(): Promise<MediaStream | null> {
    if (!LocalMedia.canScreenShare()) return null;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this._screenStream = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          this.stopScreenShare();
        };
      }
      this.emit('screen-stream', stream);
      return stream;
    } catch (error) {
      this.emit('error', { kind: 'getDisplayMedia', error });
      return null;
    }
  }

  stopScreenShare(): void {
    const s = this._screenStream;
    if (!s) return;
    s.getTracks().forEach((t) => t.stop());
    this._screenStream = null;
    this.emit('screen-stream', null);
    this.emit('screen-share-end', undefined as void);
  }

  dispose(): void {
    this._localStream?.getTracks().forEach((t) => t.stop());
    this._screenStream?.getTracks().forEach((t) => t.stop());
    this._localStream = null;
    this._screenStream = null;
    this.removeAllListeners();
  }
}
