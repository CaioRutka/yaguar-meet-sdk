/**
 * Server-side configuration types for the Yaguar Meet SDK.
 * Pure types — no runtime, no business rules (no default rubric / prompts).
 *
 * Shared record types (RoomRecord, MeetingRecord, etc.) live in `../shared/types`.
 */
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import type { Socket } from 'socket.io';
import type { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import type { AIService } from './ai/AIService';
import type { IceServerConfig, MeetingRecord } from '../shared/types';

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

export interface YaguarMeetHooks {
  onJoin?: (ctx: JoinLeaveContext) => void | Promise<void>;
  onLeave?: (ctx: JoinLeaveContext) => void | Promise<void>;
  onMeetingEnd?: (ctx: MeetingEndContext) => void | Promise<void>;
}

export interface JoinLeaveContext {
  roomId: string;
  socketId: string;
  name: string;
  meetingId?: string | null;
}

export interface MeetingEndContext {
  roomId: string;
  meetingId: string;
  meeting: MeetingRecord;
}

export interface YaguarMeetAuthConfig {
  httpAuth?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  socketAuth?: (socket: Socket, next: (err?: Error) => void) => void;
}

export interface YaguarMeetCorsConfig {
  origin?: string | boolean | RegExp | (string | boolean | RegExp)[];
  methods?: string | string[];
  credentials?: boolean;
  allowedHeaders?: string | string[];
}

/**
 * Resolver invoked per-meeting to fetch the rubric (e.g. host-specific overrides).
 * Returns the list of evaluation parameters that will be snapshotted onto the
 * meeting metadata and passed to `AIService.analyzeMeeting`.
 */
export type RubricResolver = (ctx: {
  roomId: string;
  meetingId: string;
  hostUserId: string | null;
}) => Promise<string[]>;

/**
 * AI configuration. The SDK ships no default rubric, prompts, or evaluation
 * language — all of those must be supplied by the consumer.
 *
 * `parameters` may be a static `string[]` (same rubric for every meeting) or a
 * `RubricResolver` (dynamic — e.g. per-host overrides). Resolver result is
 * persisted on the meeting metadata so re-analyses are reproducible.
 */
export interface YaguarMeetAiConfig {
  service: AIService;
  /** Evaluation parameters: static list or a resolver invoked per meeting. */
  parameters: string[] | RubricResolver;
}

export interface YaguarMeetRoomConfig {
  maxParticipants: number;
  cleanupTimeoutMs: number;
}

export interface YaguarMeetConfig {
  adapter: DatabaseAdapter;
  cors?: YaguarMeetCorsConfig;
  iceServers?: IceServerConfig[];
  room?: Partial<YaguarMeetRoomConfig>;
  ai?: YaguarMeetAiConfig;
  recordingTmpDir?: string;
  auth?: YaguarMeetAuthConfig;
  hooks?: YaguarMeetHooks;
}

export interface AttachOptions {
  httpServer: HttpServer;
}
