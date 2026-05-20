/**
 * Test-only DatabaseAdapter — small, deterministic, no external deps.
 * Mirrors `backend/InMemoryAdapter` but lives next to the SDK tests so the
 * SDK doesn't need a runtime dependency on the backend.
 */
import type { DatabaseAdapter } from '../../src/adapters/DatabaseAdapter';
import type {
  AnalysisRecord,
  CreateRoomDTO,
  MeetingAttendeeRecord,
  MeetingRecord,
  ParticipantRecord,
  RoomRecord,
  ScheduleReturnRecord,
  UserMeetingListItem,
} from '../../src/shared/types';

type InternalRoom = RoomRecord & { participants: Map<string, ParticipantRecord> };

export class MemoryAdapter implements DatabaseAdapter {
  readonly rooms = new Map<string, InternalRoom>();
  readonly meetings = new Map<string, MeetingRecord>();
  readonly attendees = new Map<string, MeetingAttendeeRecord[]>();
  readonly analyses = new Map<string, AnalysisRecord>();
  readonly scheduleReturns = new Map<string, ScheduleReturnRecord[]>();

  private idCounter = 0;
  private nextId(): string {
    this.idCounter += 1;
    return `id-${this.idCounter}`;
  }

  async createRoom(data: CreateRoomDTO): Promise<RoomRecord> {
    const id = data.id ?? this.nextId();
    const room: InternalRoom = {
      id,
      createdAt: new Date().toISOString(),
      maxParticipants: data.maxParticipants ?? 6,
      status: 'active',
      metadata: data.metadata ?? {},
      activeMeetingId: null,
      waitingRoom: data.waitingRoom ?? true,
      participants: new Map(),
    };
    if (data.createdBy) room.createdBy = data.createdBy;
    this.rooms.set(id, room);
    return room;
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    return this.rooms.get(roomId) ?? null;
  }

  async updateRoom(roomId: string, data: Partial<RoomRecord>): Promise<void> {
    const r = this.rooms.get(roomId);
    if (!r) return;
    Object.assign(r, data);
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }

  async addRoomParticipant(roomId: string, participant: ParticipantRecord): Promise<void> {
    const r = this.rooms.get(roomId);
    if (!r) return;
    if (!participant.socketId) return;
    r.participants.set(participant.socketId, participant);
  }

  async removeRoomParticipant(roomId: string, socketId: string): Promise<void> {
    this.rooms.get(roomId)?.participants.delete(socketId);
  }

  async getRoomParticipants(roomId: string): Promise<ParticipantRecord[]> {
    const r = this.rooms.get(roomId);
    if (!r) return [];
    return Array.from(r.participants.values());
  }

  async saveMeeting(data: Partial<MeetingRecord> & { roomId: string }): Promise<MeetingRecord> {
    const id = data.id ?? this.nextId();
    const meeting: MeetingRecord = {
      id,
      roomId: data.roomId,
      startedAt: data.startedAt ?? new Date().toISOString(),
      status: data.status ?? 'active',
      endedAt: data.endedAt ?? null,
      durationSeconds: data.durationSeconds ?? null,
      participantCount: data.participantCount ?? null,
      transcript: data.transcript ?? null,
      audioUrl: data.audioUrl ?? null,
      metadata: data.metadata ?? null,
    };
    this.meetings.set(id, meeting);
    return meeting;
  }

  async updateMeeting(meetingId: string, data: Partial<MeetingRecord>): Promise<void> {
    const m = this.meetings.get(meetingId);
    if (!m) return;
    Object.assign(m, data);
  }

  async getMeeting(meetingId: string): Promise<MeetingRecord | null> {
    return this.meetings.get(meetingId) ?? null;
  }

  async getMeetingsByRoom(roomId: string): Promise<MeetingRecord[]> {
    return Array.from(this.meetings.values()).filter((m) => m.roomId === roomId);
  }

  async addMeetingAttendee(
    meetingId: string,
    data: { userId: string; displayName: string; isHost: boolean; joinedAt: string }
  ): Promise<void> {
    const list = this.attendees.get(meetingId) ?? [];
    if (list.some((a) => a.userId === data.userId)) return;
    list.push({
      id: this.nextId(),
      meetingId,
      userId: data.userId,
      displayName: data.displayName,
      isHost: data.isHost,
      joinedAt: data.joinedAt,
      leftAt: null,
    });
    this.attendees.set(meetingId, list);
  }

  async updateMeetingAttendeeLeft(meetingId: string, userId: string, leftAt: string): Promise<void> {
    const list = this.attendees.get(meetingId);
    if (!list) return;
    const a = list.find((x) => x.userId === userId);
    if (a) a.leftAt = leftAt;
  }

  async getMeetingAttendees(meetingId: string): Promise<MeetingAttendeeRecord[]> {
    return this.attendees.get(meetingId) ?? [];
  }

  async listMeetingsForUser(userId: string): Promise<UserMeetingListItem[]> {
    const items: UserMeetingListItem[] = [];
    for (const [meetingId, list] of this.attendees.entries()) {
      const me = list.find((a) => a.userId === userId);
      if (!me) continue;
      const meeting = this.meetings.get(meetingId);
      if (!meeting) continue;
      items.push({
        meetingId,
        roomId: meeting.roomId,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt ?? null,
        durationSeconds: meeting.durationSeconds ?? null,
        participantCount: meeting.participantCount ?? null,
        status: meeting.status,
        isHost: me.isHost,
        hasAnalysis: this.analyses.has(meetingId),
      });
    }
    return items;
  }

  async saveAnalysis(
    data: Omit<AnalysisRecord, 'id' | 'createdAt'> & { id?: string }
  ): Promise<AnalysisRecord> {
    const rec: AnalysisRecord = {
      id: data.id ?? this.nextId(),
      meetingId: data.meetingId,
      overallScore: data.overallScore,
      summary: data.summary,
      strengths: [...data.strengths],
      improvements: [...data.improvements],
      feedback: data.feedback,
      parameterScores: { ...data.parameterScores },
      createdAt: new Date().toISOString(),
    };
    this.analyses.set(data.meetingId, rec);
    return rec;
  }

  async getAnalysisByMeeting(meetingId: string): Promise<AnalysisRecord | null> {
    return this.analyses.get(meetingId) ?? null;
  }

  async saveScheduleReturn(
    data: Omit<ScheduleReturnRecord, 'id' | 'createdAt'> & { id?: string }
  ): Promise<ScheduleReturnRecord> {
    const rec: ScheduleReturnRecord = {
      id: data.id ?? this.nextId(),
      meetingId: data.meetingId,
      scheduledFor: data.scheduledFor,
      notes: data.notes ?? null,
      createdAt: new Date().toISOString(),
    };
    const list = this.scheduleReturns.get(data.meetingId) ?? [];
    list.push(rec);
    this.scheduleReturns.set(data.meetingId, list);
    return rec;
  }

  async getScheduleReturnsByMeeting(meetingId: string): Promise<ScheduleReturnRecord[]> {
    return this.scheduleReturns.get(meetingId) ?? [];
  }

  async countRooms(): Promise<number> {
    return this.rooms.size;
  }

  async vacateRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }
}
