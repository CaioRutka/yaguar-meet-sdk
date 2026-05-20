/**
 * Top-level meeting orchestrator combining signaling, media, peer connections,
 * recording, and speaking detection into a single ergonomic façade.
 *
 * No React, no framework — just classes + events.
 */
import type {
  IceServerConfig,
  LiveParticipantView,
  ChatMessagePayload,
  WaitingParticipant,
  AnalysisRecord,
} from '../shared/types';
import { TypedEmitter } from './typedEmitter';
import { LocalMedia } from './LocalMedia';
import { SignalingClient, type SignalingClientOptions } from './SignalingClient';
import { PeerConnectionManager } from './PeerConnectionManager';
import { AudioRecorder } from './AudioRecorder';
import { SpeakingDetector } from './SpeakingDetector';

export interface MeetingClientOptions {
  url: string;
  roomId: string;
  userId: string;
  displayName: string;
  iceServers?: IceServerConfig[];
  initialStream?: MediaStream;
  enableSpeakingDetector?: boolean;
  socketOptions?: SignalingClientOptions['socketOptions'];
}

export interface MeetingClientEvents extends Record<string, unknown> {
  ready: { isHost: boolean; meetingId: string | null };
  'remote-stream': { socketId: string; stream: MediaStream };
  'remote-stream-removed': { socketId: string };
  'peer-joined': LiveParticipantView;
  'peer-left': { socketId: string; name?: string };
  'chat-message': ChatMessagePayload;
  'screen-sharing': { socketId: string; isSharing: boolean };
  'mic-speaking': { socketId: string; speaking: boolean };
  'admission-request': WaitingParticipant;
  'admission-sync': { waiting: WaitingParticipant[] };
  waiting: { roomId: string };
  admitted: { roomId: string };
  rejected: { message: string };
  'meeting-complete': {
    roomId: string;
    meetingId: string;
    analysis: AnalysisRecord | null;
    analysisFallback: string | null;
  };
  'meeting-ended': { roomId: string; meetingId: string };
  error: { source: string; error: unknown };
}

export class MeetingClient extends TypedEmitter<MeetingClientEvents> {
  readonly signaling: SignalingClient;
  readonly localMedia: LocalMedia;
  readonly peers: PeerConnectionManager;
  readonly recorder: AudioRecorder;
  readonly speakingDetector: SpeakingDetector | null;

  private _roomId: string;
  private _meetingId: string | null = null;
  private _isHost = false;
  private _joined = false;
  private offDisposers: (() => void)[] = [];

  constructor(private readonly options: MeetingClientOptions) {
    super();
    this._roomId = options.roomId;
    this.signaling = new SignalingClient({
      url: options.url,
      socketOptions: options.socketOptions,
    });
    this.localMedia = new LocalMedia();
    if (options.initialStream) this.localMedia.setStream(options.initialStream);

    this.peers = new PeerConnectionManager(this.signaling, { iceServers: options.iceServers });
    this.recorder = new AudioRecorder(this.signaling, { roomId: options.roomId });
    this.speakingDetector =
      options.enableSpeakingDetector !== false ? new SpeakingDetector() : null;

    this.wireEvents();
  }

  get roomId(): string {
    return this._roomId;
  }

  get meetingId(): string | null {
    return this._meetingId;
  }

  get isHost(): boolean {
    return this._isHost;
  }

  get hasJoined(): boolean {
    return this._joined;
  }

  async join(): Promise<void> {
    if (!this.localMedia.localStream && !this.options.initialStream) {
      await this.localMedia.startCamera();
    }
    if (this.localMedia.localStream) {
      this.peers.setLocalStream(this.localMedia.localStream);
      if (this.speakingDetector) this.speakingDetector.start(this.localMedia.localStream);
    }
    this.signaling.connect();
    this.signaling.joinRoom({
      roomId: this._roomId,
      name: this.options.displayName,
      userId: this.options.userId,
    });
  }

  leave(): void {
    this.recorder.stop();
    this.speakingDetector?.stop();
    this.signaling.leaveRoom();
    this.signaling.disconnect();
    this._joined = false;
  }

  toggleMic(): void {
    this.localMedia.toggleMic();
  }

  toggleCam(): void {
    this.localMedia.toggleCam();
  }

  async startScreenShare(): Promise<MediaStream | null> {
    const stream = await this.localMedia.startScreenShare();
    if (stream) {
      this.peers.setScreenStream(stream);
      this.signaling.broadcastScreenSharing(this._roomId, true);
    }
    return stream;
  }

  stopScreenShare(): void {
    this.localMedia.stopScreenShare();
    this.peers.setScreenStream(null);
    this.signaling.broadcastScreenSharing(this._roomId, false);
  }

  startRecording(): boolean {
    if (!this._isHost) return false;
    const stream = this.localMedia.localStream;
    if (!stream) return false;
    return this.recorder.start(stream);
  }

  stopRecording(): void {
    this.recorder.stop();
  }

  sendChat(message: string): void {
    this.signaling.sendChat(this._roomId, message);
  }

  admit(socketId: string): void {
    this.signaling.admit(this._roomId, socketId);
  }

  reject(socketId: string): void {
    this.signaling.reject(this._roomId, socketId);
  }

  scheduleReturn(scheduledFor: string, notes?: string): void {
    if (!this._meetingId) return;
    this.signaling.scheduleReturn({
      roomId: this._roomId,
      meetingId: this._meetingId,
      scheduledFor,
      ...(notes ? { notes } : {}),
    });
  }

  dispose(): void {
    for (const off of this.offDisposers) off();
    this.offDisposers = [];
    this.recorder.dispose();
    this.speakingDetector?.dispose();
    this.peers.dispose();
    this.localMedia.dispose();
    this.signaling.dispose();
    this.removeAllListeners();
  }

  private wireEvents(): void {
    this.offDisposers.push(
      this.signaling.on('ice-servers', (servers) => {
        this.peers.setIceServers(servers);
      }),
      this.signaling.on('room-session', ({ roomId, meetingId, isHost }) => {
        this._roomId = roomId;
        this._meetingId = meetingId;
        this._isHost = isHost;
        this._joined = true;
        this.emit('ready', { isHost, meetingId });
      }),
      this.signaling.on('room-participants', ({ participants }) => {
        const me = this.signaling.socketId;
        for (const p of participants) {
          if (p.socketId === me) continue;
          void this.peers.dial(p.socketId);
        }
      }),
      this.signaling.on('peer-joined', (p) => this.emit('peer-joined', p)),
      this.signaling.on('peer-left', (p) => this.emit('peer-left', p)),
      this.peers.on('remote-stream', (p) => this.emit('remote-stream', p)),
      this.peers.on('remote-stream-removed', (p) => this.emit('remote-stream-removed', p)),
      this.peers.on('error', (p) => this.emit('error', { source: 'peer', error: p.error })),
      this.signaling.on('chat-message', (m) => this.emit('chat-message', m)),
      this.signaling.on('screen-sharing', (p) => this.emit('screen-sharing', p)),
      this.signaling.on('mic-speaking', (p) => this.emit('mic-speaking', p)),
      this.signaling.on('room-admission-request', (p) => this.emit('admission-request', p)),
      this.signaling.on('room-admission-sync', (p) => this.emit('admission-sync', p)),
      this.signaling.on('room-waiting', (p) => this.emit('waiting', p)),
      this.signaling.on('room-admitted', (p) => this.emit('admitted', p)),
      this.signaling.on('room-rejected', (p) => this.emit('rejected', p)),
      this.signaling.on('meeting-ended', (p) => this.emit('meeting-ended', p)),
      this.signaling.on('meeting-complete', (p) => this.emit('meeting-complete', p)),
      this.signaling.on('recording-error', (p) => this.emit('error', { source: 'recording', error: p })),
      this.signaling.on('connect-error', (p) => this.emit('error', { source: 'connect', error: p.error })),
      this.localMedia.on('camera-stream', (stream) => {
        this.peers.setLocalStream(stream);
        if (stream && this.speakingDetector) this.speakingDetector.start(stream);
      })
    );

    if (this.speakingDetector) {
      this.offDisposers.push(
        this.speakingDetector.on('change', (speaking) => {
          this.signaling.broadcastSpeaking(this._roomId, speaking);
        })
      );
    }
  }
}
