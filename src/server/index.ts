/**
 * `@yaguar/meet/server` — Node-side SDK entry.
 */

export { YaguarMeet } from './YaguarMeet';
export type {
  YaguarMeetConfig,
  YaguarMeetAuthConfig,
  YaguarMeetAiConfig,
  YaguarMeetRoomConfig,
  YaguarMeetCorsConfig,
  YaguarMeetHooks,
  JoinLeaveContext,
  MeetingEndContext,
  AttachOptions,
  RubricResolver,
} from './types';

export { RoomManager } from './RoomManager';
export type { LiveParticipant, MeetingProcessingContext, JoinRoomResult } from './RoomManager';

export { RecordingSessionManager } from './RecordingSessionManager';

export { registerSocketHandlers } from './registerSocketHandlers';
export type { SignalingContext } from './registerSocketHandlers';

export type { AIService } from './ai/AIService';
export { GeminiService } from './ai/GeminiService';
export type { GeminiServiceOptions } from './ai/GeminiService';

export { handleMeetHttp } from './http/meetHttp';
export type { MeetHttpOptions } from './http/meetHttp';
export {
  parsePath,
  parseQuery,
  pathUnderPrefix,
  readJsonBody,
  sendJson,
  segments,
  serializeErrorForHttp,
} from './http/httpUtil';

export type { DatabaseAdapter } from '../adapters/DatabaseAdapter';

export type {
  IceServerConfig,
  RoomRecord,
  CreateRoomDTO,
  WaitingParticipant,
  MeetingRecord,
  MeetingAttendeeRecord,
  UserMeetingListItem,
  AnalysisRecord,
  ParticipantRecord,
  ScheduleReturnRecord,
  MeetingAnalysisResult,
  LiveParticipantView,
  ChatMessagePayload,
} from '../shared/types';
