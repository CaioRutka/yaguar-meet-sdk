/**
 * Shared data types — used by both server SDK and client SDK,
 * and importable by SDK consumers (backend impls, frontend).
 *
 * No runtime; pure type definitions.
 * No Node-specific or DOM-specific dependencies here.
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RoomRecord {
  id: string;
  createdAt: string;
  createdBy?: string;
  maxParticipants: number;
  status: 'active' | 'ended';
  metadata: Record<string, unknown>;
  activeMeetingId?: string | null;
  waitingRoom?: boolean;
}

export interface CreateRoomDTO {
  id?: string;
  createdBy?: string;
  maxParticipants?: number;
  metadata?: Record<string, unknown>;
  waitingRoom?: boolean;
}

export interface WaitingParticipant {
  socketId: string;
  name: string;
  userId?: string;
  requestedAt: string;
}

export interface MeetingRecord {
  id: string;
  roomId: string;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  participantCount?: number | null;
  status: 'active' | 'ended' | 'processing' | 'completed';
  transcript?: string | null;
  audioUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MeetingAttendeeRecord {
  id: string;
  meetingId: string;
  userId: string;
  displayName: string;
  isHost: boolean;
  joinedAt: string;
  leftAt?: string | null;
}

export interface UserMeetingListItem {
  meetingId: string;
  roomId: string;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  participantCount?: number | null;
  status: MeetingRecord['status'];
  isHost: boolean;
  hasAnalysis: boolean;
}

export interface AnalysisRecord {
  id: string;
  meetingId: string;
  overallScore: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  feedback: string;
  parameterScores: Record<string, number>;
  createdAt: string;
}

export interface ParticipantRecord {
  socketId?: string;
  name: string;
  role?: string;
  joinedAt: string;
  leftAt?: string | null;
  meetingId?: string | null;
}

export interface ScheduleReturnRecord {
  id: string;
  meetingId: string;
  scheduledFor: string;
  notes?: string | null;
  createdAt: string;
}

export interface MeetingAnalysisResult {
  overallScore: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  feedback: string;
  parameterScores: Record<string, number>;
}

export interface LiveParticipantView {
  socketId: string;
  name: string;
}

export interface ChatMessagePayload {
  id: string;
  sender: string;
  senderId: string;
  message: string;
  timestamp: string;
}
