/**
 * `@yaguar/meet/client` — browser-side SDK entry.
 *
 * Contains vanilla classes for WebRTC peer connections, local media,
 * signaling, audio recording, speaking detection, and the high-level
 * `MeetingClient` orchestrator. No framework dependencies.
 */

export { TypedEmitter } from './typedEmitter';
export { createPeerConnection } from './webrtc';

export { LocalMedia } from './LocalMedia';
export type { LocalMediaEvents } from './LocalMedia';

export {
  SignalingClient,
  type SignalingClientOptions,
  type SignalingEvents,
  type SignalPayload,
  type JoinPayload,
} from './SignalingClient';

export {
  PeerConnectionManager,
  type PeerConnectionManagerEvents,
} from './PeerConnectionManager';

export { AudioRecorder, type AudioRecorderEvents } from './AudioRecorder';
export {
  SpeakingDetector,
  type SpeakingDetectorEvents,
  type SpeakingDetectorOptions,
} from './SpeakingDetector';

export {
  MeetingClient,
  type MeetingClientOptions,
  type MeetingClientEvents,
} from './MeetingClient';

export type {
  IceServerConfig,
  LiveParticipantView,
  ChatMessagePayload,
  WaitingParticipant,
  MeetingAnalysisResult,
  AnalysisRecord,
  RoomRecord,
  MeetingRecord,
  ParticipantRecord,
  ScheduleReturnRecord,
} from '../shared/types';
