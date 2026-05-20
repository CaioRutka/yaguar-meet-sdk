import type {
  AnalysisRecord,
  CreateRoomDTO,
  MeetingAttendeeRecord,
  MeetingRecord,
  ParticipantRecord,
  RoomRecord,
  ScheduleReturnRecord,
  UserMeetingListItem,
} from '../shared/types';

/**
 * Persistence boundary for Yaguar Meet.
 * Implementations: InMemoryAdapter, SupabaseAdapter, MongoAdapter.
 */
export interface DatabaseAdapter {
  // Rooms
  createRoom(data: CreateRoomDTO): Promise<RoomRecord>;
  getRoom(roomId: string): Promise<RoomRecord | null>;
  updateRoom(roomId: string, data: Partial<RoomRecord>): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;

  /** Live participants in the room (WebRTC session) */
  addRoomParticipant(roomId: string, participant: ParticipantRecord): Promise<void>;
  removeRoomParticipant(roomId: string, socketId: string): Promise<void>;
  getRoomParticipants(roomId: string): Promise<ParticipantRecord[]>;

  // Meetings
  saveMeeting(data: Partial<MeetingRecord> & { roomId: string }): Promise<MeetingRecord>;
  updateMeeting(meetingId: string, data: Partial<MeetingRecord>): Promise<void>;
  getMeeting(meetingId: string): Promise<MeetingRecord | null>;
  getMeetingsByRoom(roomId: string): Promise<MeetingRecord[]>;

  addMeetingAttendee(
    meetingId: string,
    data: { userId: string; displayName: string; isHost: boolean; joinedAt: string }
  ): Promise<void>;
  updateMeetingAttendeeLeft(meetingId: string, userId: string, leftAt: string): Promise<void>;
  getMeetingAttendees(meetingId: string): Promise<MeetingAttendeeRecord[]>;
  /** Reuniões em que o usuário entrou (cada item indica se foi anfitrião). */
  listMeetingsForUser(userId: string): Promise<UserMeetingListItem[]>;

  // AI Analysis
  saveAnalysis(data: Omit<AnalysisRecord, 'id' | 'createdAt'> & { id?: string }): Promise<AnalysisRecord>;
  getAnalysisByMeeting(meetingId: string): Promise<AnalysisRecord | null>;

  // Schedule return (inside-room feature)
  saveScheduleReturn(
    data: Omit<ScheduleReturnRecord, 'id' | 'createdAt'> & { id?: string }
  ): Promise<ScheduleReturnRecord>;
  getScheduleReturnsByMeeting(meetingId: string): Promise<ScheduleReturnRecord[]>;

  /** Rooms currently tracked (for health / metrics) */
  countRooms(): Promise<number>;

  /**
   * Called when a room has been empty after cleanup delay.
   * InMemory: remove room; Supabase: archive and clear live participants.
   */
  vacateRoom(roomId: string): Promise<void>;
}
