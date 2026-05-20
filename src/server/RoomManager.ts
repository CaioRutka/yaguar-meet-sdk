import type { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import type { WaitingParticipant } from '../shared/types';
import type { YaguarMeetRoomConfig } from './types';

export interface LiveParticipant {
  socketId: string;
  name: string;
  joinedAt: Date;
}

export type MeetingProcessingContext = {
  roomId: string;
  meetingId: string | null;
};

export type JoinRoomResult =
  | { success: true; participants: LiveParticipant[]; meetingId: string | null }
  | { success: false; error: string }
  | { success: false; waiting: true };

export class RoomManager {
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Fast lookup for disconnect — works with any adapter */
  private socketToRoom = new Map<string, string>();
  /** roomId → socketId → waiting guest */
  private waitingByRoom = new Map<string, Map<string, WaitingParticipant>>();

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly roomConfig: YaguarMeetRoomConfig,
    private readonly onMeetingProcessing?: (ctx: MeetingProcessingContext) => void | Promise<void>
  ) {}

  async createRoom(dto?: { createdBy?: string; waitingRoom?: boolean }): Promise<{ id: string; createdAt: string }> {
    const room = await this.adapter.createRoom({
      maxParticipants: this.roomConfig.maxParticipants,
      createdBy: dto?.createdBy,
      waitingRoom: dto?.waitingRoom,
    });
    return { id: room.id, createdAt: room.createdAt };
  }

  async getRoom(roomId: string) {
    return this.adapter.getRoom(roomId);
  }

  async roomExists(roomId: string): Promise<boolean> {
    const r = await this.adapter.getRoom(roomId);
    return r !== null;
  }

  private isWaitingRoomEnabled(room: { waitingRoom?: boolean }): boolean {
    return room.waitingRoom !== false;
  }

  getWaitingParticipants(roomId: string): WaitingParticipant[] {
    const q = this.waitingByRoom.get(roomId);
    if (!q) return [];
    return Array.from(q.values());
  }

  getWaitingParticipant(roomId: string, socketId: string): WaitingParticipant | undefined {
    return this.waitingByRoom.get(roomId)?.get(socketId);
  }

  removeFromWaitingQueue(roomId: string, socketId: string): void {
    const q = this.waitingByRoom.get(roomId);
    if (!q) return;
    q.delete(socketId);
    if (q.size === 0) this.waitingByRoom.delete(roomId);
  }

  rejectWaiting(roomId: string, socketId: string): WaitingParticipant | null {
    const p = this.getWaitingParticipant(roomId, socketId);
    if (!p) return null;
    this.removeFromWaitingQueue(roomId, socketId);
    return p;
  }

  /**
   * Completes join for a participant already authorized (direct join or after admission).
   */
  private async finalizeJoin(
    roomId: string,
    socketId: string,
    name: string,
    options?: { userId?: string }
  ): Promise<JoinRoomResult> {
    const room = await this.adapter.getRoom(roomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    const existing = await this.adapter.getRoomParticipants(roomId);
    if (existing.length >= room.maxParticipants) {
      return {
        success: false,
        error: `Room is full (max ${room.maxParticipants} participants)`,
      };
    }

    this.clearCleanupTimer(roomId);

    let meetingId = room.activeMeetingId ?? undefined;
    if (!meetingId) {
      const meeting = await this.adapter.saveMeeting({ roomId, status: 'active' });
      meetingId = meeting.id;
      await this.adapter.updateRoom(roomId, { activeMeetingId: meetingId });
    }

    const joinedAt = new Date().toISOString();
    await this.adapter.addRoomParticipant(roomId, {
      socketId,
      name,
      joinedAt,
      meetingId: meetingId ?? null,
    });

    const uid = options?.userId?.trim();
    if (uid && meetingId) {
      const isHost = Boolean(room.createdBy && room.createdBy === uid);
      await this.adapter.addMeetingAttendee(meetingId, {
        userId: uid.slice(0, 128),
        displayName: name.slice(0, 200),
        isHost,
        joinedAt,
      });
    }

    this.socketToRoom.set(socketId, roomId);

    const participants = await this.adapter.getRoomParticipants(roomId);
    return {
      success: true,
      participants: participants.map((p) => ({
        socketId: p.socketId!,
        name: p.name,
        joinedAt: new Date(p.joinedAt),
      })),
      meetingId,
    };
  }

  async joinRoom(roomId: string, socketId: string, name: string, options?: { userId?: string }): Promise<JoinRoomResult> {
    const room = await this.adapter.getRoom(roomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    const uid = options?.userId?.trim();
    const isHost = Boolean(uid && room.createdBy && room.createdBy === uid);

    if (this.isWaitingRoomEnabled(room) && !isHost) {
      const existing = await this.adapter.getRoomParticipants(roomId);
      if (existing.length >= room.maxParticipants) {
        return {
          success: false,
          error: `Room is full (max ${room.maxParticipants} participants)`,
        };
      }

      const q = this.waitingByRoom.get(roomId) ?? new Map<string, WaitingParticipant>();
      const entry: WaitingParticipant = {
        socketId,
        name: name.slice(0, 200),
        userId: uid,
        requestedAt: new Date().toISOString(),
      };
      q.set(socketId, entry);
      this.waitingByRoom.set(roomId, q);
      return { success: false, waiting: true };
    }

    return this.finalizeJoin(roomId, socketId, name, options);
  }

  /** Admit a socket that is currently in the waiting queue. */
  async admitToRoom(roomId: string, targetSocketId: string): Promise<JoinRoomResult> {
    const pending = this.getWaitingParticipant(roomId, targetSocketId);
    if (!pending) {
      return { success: false, error: 'Participant is not waiting' };
    }
    this.removeFromWaitingQueue(roomId, targetSocketId);
    return this.finalizeJoin(roomId, targetSocketId, pending.name, { userId: pending.userId });
  }

  async leaveRoom(
    roomId: string,
    socketId: string,
    options?: { meetUserId?: string }
  ): Promise<LiveParticipant | null> {
    const list = await this.adapter.getRoomParticipants(roomId);
    const p = list.find((x) => x.socketId === socketId);
    if (!p) return null;

    const meetingId = p.meetingId ? String(p.meetingId) : null;
    const meetUserId = options?.meetUserId?.trim();

    await this.adapter.removeRoomParticipant(roomId, socketId);
    if (meetUserId && meetingId) {
      await this.adapter.updateMeetingAttendeeLeft(meetingId, meetUserId.slice(0, 128), new Date().toISOString());
    }
    this.socketToRoom.delete(socketId);

    const room = await this.adapter.getRoom(roomId);
    const remaining = await this.adapter.getRoomParticipants(roomId);

    if (remaining.length === 0 && room) {
      this.scheduleCleanup(roomId, room.activeMeetingId);
    }

    return {
      socketId: p.socketId!,
      name: p.name,
      joinedAt: new Date(p.joinedAt),
    };
  }

  findRoomBySocket(socketId: string): string | null {
    return this.socketToRoom.get(socketId) ?? null;
  }

  private clearCleanupTimer(roomId: string): void {
    const t = this.cleanupTimers.get(roomId);
    if (t) {
      clearTimeout(t);
      this.cleanupTimers.delete(roomId);
    }
  }

  private scheduleCleanup(roomId: string, activeMeetingId: string | null | undefined): void {
    this.clearCleanupTimer(roomId);
    const timer = setTimeout(() => {
      void this.runEmptyRoomCleanup(roomId, activeMeetingId);
    }, this.roomConfig.cleanupTimeoutMs);
    this.cleanupTimers.set(roomId, timer);
  }

  private async runEmptyRoomCleanup(roomId: string, activeMeetingId: string | null | undefined): Promise<void> {
    const still = await this.adapter.getRoomParticipants(roomId);
    if (still.length > 0) return;

    const endedAt = new Date().toISOString();
    if (activeMeetingId) {
      const meeting = await this.adapter.getMeeting(activeMeetingId);
      if (meeting) {
        const start = new Date(meeting.startedAt).getTime();
        const durationSeconds = Math.max(0, Math.round((Date.now() - start) / 1000));
        const attendees = await this.adapter.getMeetingAttendees(activeMeetingId);
        await this.adapter.updateMeeting(activeMeetingId, {
          endedAt,
          durationSeconds,
          status: 'processing',
          participantCount: attendees.length,
        });
      }
    }

    await this.adapter.updateRoom(roomId, { activeMeetingId: null });

    try {
      await this.onMeetingProcessing?.({ roomId, meetingId: activeMeetingId ?? null });
    } catch (e) {
      console.error('[RoomManager] onMeetingProcessing error', e);
    }

    await this.adapter.vacateRoom(roomId);
    this.waitingByRoom.delete(roomId);
    this.cleanupTimers.delete(roomId);
  }

  async getParticipants(roomId: string): Promise<LiveParticipant[]> {
    const participants = await this.adapter.getRoomParticipants(roomId);
    return participants.map((p) => ({
      socketId: p.socketId!,
      name: p.name,
      joinedAt: new Date(p.joinedAt),
    }));
  }

  async getRoomCount(): Promise<number> {
    return this.adapter.countRooms();
  }

}
