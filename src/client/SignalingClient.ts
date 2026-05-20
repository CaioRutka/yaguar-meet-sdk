/**
 * Thin typed wrapper around `socket.io-client`.
 *
 * Owns the lifecycle of the socket and translates raw Socket.IO events into a
 * typed event surface for SDK consumers.
 */
import { io, type Socket } from 'socket.io-client';
import type {
  IceServerConfig,
  LiveParticipantView,
  ChatMessagePayload,
  WaitingParticipant,
  MeetingAnalysisResult,
  AnalysisRecord,
} from '../shared/types';
import { TypedEmitter } from './typedEmitter';

export interface SignalingClientOptions {
  url: string;
  path?: string;
  transports?: ('websocket' | 'polling')[];
  autoConnect?: boolean;
  socketOptions?: Record<string, unknown>;
}

export type SignalPayload = unknown;

export interface SignalingEvents extends Record<string, unknown> {
  connect: void;
  disconnect: { reason: string };
  'connect-error': { error: unknown };

  'ice-servers': IceServerConfig[];

  'room-session': { roomId: string; meetingId: string | null; isHost: boolean };
  'room-participants': { participants: LiveParticipantView[]; meetingId: string | null; isHost: boolean };
  'room-waiting': { roomId: string };
  'room-admission-request': WaitingParticipant;
  'room-admission-sync': { waiting: WaitingParticipant[] };
  'room-admitted': { roomId: string };
  'room-rejected': { message: string };
  'room-error': { message: string };

  'peer-joined': LiveParticipantView;
  'peer-left': { socketId: string; name?: string };

  offer: { from: string; signal: SignalPayload };
  answer: { from: string; signal: SignalPayload };
  'ice-candidate': { from: string; signal: SignalPayload };

  'chat-message': ChatMessagePayload;

  'screen-sharing': { socketId: string; isSharing: boolean };
  'mic-speaking': { socketId: string; speaking: boolean };

  'recording-error': { message: string };

  'meeting-ended': { roomId: string; meetingId: string };
  'meeting-complete': {
    roomId: string;
    meetingId: string;
    analysis: AnalysisRecord | null;
    analysisFallback: string | null;
  };

  'schedule-return-confirmed': { id: string; meetingId: string; scheduledFor: string; notes: string | null };
  'schedule-return-error': { message: string };
}

export interface JoinPayload {
  roomId: string;
  name: string;
  userId?: string;
}

export class SignalingClient extends TypedEmitter<SignalingEvents> {
  private readonly socket: Socket;

  constructor(options: SignalingClientOptions) {
    super();
    this.socket = io(options.url, {
      path: options.path,
      autoConnect: options.autoConnect !== false,
      transports: options.transports ?? ['websocket', 'polling'],
      ...options.socketOptions,
    });
    this.wireSocketEvents();
  }

  get socketId(): string | null {
    return this.socket.id ?? null;
  }

  get rawSocket(): Socket {
    return this.socket;
  }

  connect(): void {
    if (!this.socket.connected) this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  joinRoom(payload: JoinPayload): void {
    this.socket.emit('room:join', payload);
  }

  leaveRoom(): void {
    this.socket.emit('room:leave');
  }

  admit(roomId: string, socketId: string): void {
    this.socket.emit('room:admit', { roomId, socketId });
  }

  reject(roomId: string, socketId: string): void {
    this.socket.emit('room:reject', { roomId, socketId });
  }

  sendOffer(to: string, signal: SignalPayload): void {
    this.socket.emit('signal:offer', { to, signal });
  }

  sendAnswer(to: string, signal: SignalPayload): void {
    this.socket.emit('signal:answer', { to, signal });
  }

  sendIceCandidate(to: string, signal: SignalPayload): void {
    this.socket.emit('signal:ice-candidate', { to, signal });
  }

  sendChat(roomId: string, message: string): void {
    this.socket.emit('chat:message', { roomId, message });
  }

  broadcastScreenSharing(roomId: string, isSharing: boolean): void {
    this.socket.emit('screen:sharing', { roomId, isSharing });
  }

  broadcastSpeaking(roomId: string, speaking: boolean): void {
    this.socket.emit('mic:speaking', { roomId, speaking });
  }

  startRecording(roomId: string, mimeType: string): void {
    this.socket.emit('recording:start', { roomId, mimeType });
  }

  appendRecordingChunk(roomId: string, chunk: string): void {
    this.socket.emit('recording:chunk', { roomId, chunk });
  }

  stopRecording(roomId: string): void {
    this.socket.emit('recording:stop', { roomId });
  }

  scheduleReturn(payload: { roomId: string; meetingId: string; scheduledFor: string; notes?: string }): void {
    this.socket.emit('schedule:return', payload);
  }

  private wireSocketEvents(): void {
    this.socket.on('connect', () => this.emit('connect', undefined as void));
    this.socket.on('disconnect', (reason) => this.emit('disconnect', { reason: String(reason) }));
    this.socket.on('connect_error', (error) => this.emit('connect-error', { error }));

    this.socket.on('config:ice-servers', (servers: IceServerConfig[]) => this.emit('ice-servers', servers));

    this.socket.on('room:session', (p: SignalingEvents['room-session']) => this.emit('room-session', p));
    this.socket.on('room:participants', (p: SignalingEvents['room-participants']) =>
      this.emit('room-participants', p)
    );
    this.socket.on('room:waiting', (p: SignalingEvents['room-waiting']) => this.emit('room-waiting', p));
    this.socket.on('room:admission-request', (p: SignalingEvents['room-admission-request']) =>
      this.emit('room-admission-request', p)
    );
    this.socket.on('room:admission-sync', (p: SignalingEvents['room-admission-sync']) =>
      this.emit('room-admission-sync', p)
    );
    this.socket.on('room:admitted', (p: SignalingEvents['room-admitted']) => this.emit('room-admitted', p));
    this.socket.on('room:rejected', (p: SignalingEvents['room-rejected']) => this.emit('room-rejected', p));
    this.socket.on('room:error', (p: SignalingEvents['room-error']) => this.emit('room-error', p));

    this.socket.on('user:joined', (p: SignalingEvents['peer-joined']) => this.emit('peer-joined', p));
    this.socket.on('user:left', (p: SignalingEvents['peer-left']) => this.emit('peer-left', p));

    this.socket.on('signal:offer', (p: SignalingEvents['offer']) => this.emit('offer', p));
    this.socket.on('signal:answer', (p: SignalingEvents['answer']) => this.emit('answer', p));
    this.socket.on('signal:ice-candidate', (p: SignalingEvents['ice-candidate']) =>
      this.emit('ice-candidate', p)
    );

    this.socket.on('chat:message', (p: SignalingEvents['chat-message']) => this.emit('chat-message', p));

    this.socket.on('screen:sharing', (p: SignalingEvents['screen-sharing']) => this.emit('screen-sharing', p));
    this.socket.on('mic:speaking', (p: SignalingEvents['mic-speaking']) => this.emit('mic-speaking', p));

    this.socket.on('recording:error', (p: SignalingEvents['recording-error']) =>
      this.emit('recording-error', p)
    );

    this.socket.on('meeting:ended', (p: SignalingEvents['meeting-ended']) => this.emit('meeting-ended', p));
    this.socket.on('meeting:complete', (p: SignalingEvents['meeting-complete']) =>
      this.emit('meeting-complete', p)
    );

    this.socket.on('schedule:return:confirmed', (p: SignalingEvents['schedule-return-confirmed']) =>
      this.emit('schedule-return-confirmed', p)
    );
    this.socket.on('schedule:return:error', (p: SignalingEvents['schedule-return-error']) =>
      this.emit('schedule-return-error', p)
    );
  }

  dispose(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.removeAllListeners();
  }
}

export type { MeetingAnalysisResult };
