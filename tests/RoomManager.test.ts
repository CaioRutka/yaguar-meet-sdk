import { describe, it, expect, vi } from 'vitest';
import { RoomManager } from '../src/server/RoomManager';
import { MemoryAdapter } from './_fixtures/MemoryAdapter';

function build() {
  const adapter = new MemoryAdapter();
  const onMeetingProcessing = vi.fn();
  const rm = new RoomManager(
    adapter,
    { maxParticipants: 3, cleanupTimeoutMs: 50 },
    onMeetingProcessing
  );
  return { adapter, rm, onMeetingProcessing };
}

describe('RoomManager', () => {
  describe('createRoom', () => {
    it('creates a room with default config', async () => {
      const { rm, adapter } = build();
      const r = await rm.createRoom({ createdBy: 'host-1' });
      expect(r.id).toBeTruthy();
      const stored = await adapter.getRoom(r.id);
      expect(stored?.maxParticipants).toBe(3);
      expect(stored?.createdBy).toBe('host-1');
    });

    it('honours waitingRoom override', async () => {
      const { rm, adapter } = build();
      const r = await rm.createRoom({ createdBy: 'host-1', waitingRoom: false });
      const stored = await adapter.getRoom(r.id);
      expect(stored?.waitingRoom).toBe(false);
    });
  });

  describe('joinRoom', () => {
    it('fails when room not found', async () => {
      const { rm } = build();
      const result = await rm.joinRoom('missing', 'sock1', 'Alice');
      expect(result.success).toBe(false);
      if (!result.success && 'error' in result) expect(result.error).toMatch(/not found/i);
    });

    it('admits host directly even with waiting room enabled', async () => {
      const { rm } = build();
      const r = await rm.createRoom({ createdBy: 'host-1' });
      const result = await rm.joinRoom(r.id, 'sock-host', 'Host', { userId: 'host-1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.participants).toHaveLength(1);
        expect(result.meetingId).toBeTruthy();
      }
    });

    it('queues non-host when waiting room is enabled', async () => {
      const { rm } = build();
      const r = await rm.createRoom({ createdBy: 'host-1' });
      const result = await rm.joinRoom(r.id, 'sock-guest', 'Guest', { userId: 'guest-1' });
      expect(result.success).toBe(false);
      if (!result.success && 'waiting' in result) expect(result.waiting).toBe(true);
      expect(rm.getWaitingParticipants(r.id)).toHaveLength(1);
    });

    it('admits non-host directly when waiting room is disabled', async () => {
      const { rm } = build();
      const r = await rm.createRoom({ createdBy: 'host-1', waitingRoom: false });
      const result = await rm.joinRoom(r.id, 'sock-guest', 'Guest', { userId: 'guest-1' });
      expect(result.success).toBe(true);
    });

    it('refuses join when room is full', async () => {
      const { rm } = build();
      const r = await rm.createRoom({ createdBy: 'host-1', waitingRoom: false });
      await rm.joinRoom(r.id, 's1', 'A', { userId: 'a' });
      await rm.joinRoom(r.id, 's2', 'B', { userId: 'b' });
      await rm.joinRoom(r.id, 's3', 'C', { userId: 'c' });
      const fourth = await rm.joinRoom(r.id, 's4', 'D', { userId: 'd' });
      expect(fourth.success).toBe(false);
      if (!fourth.success && 'error' in fourth) {
        expect(fourth.error).toMatch(/full/i);
      }
    });

    it('persists host attendee with isHost=true', async () => {
      const { rm, adapter } = build();
      const r = await rm.createRoom({ createdBy: 'host-1' });
      const result = await rm.joinRoom(r.id, 'sock-host', 'Host', { userId: 'host-1' });
      expect(result.success).toBe(true);
      if (!result.success || !result.meetingId) throw new Error('expected meetingId');
      const attendees = await adapter.getMeetingAttendees(result.meetingId);
      expect(attendees).toHaveLength(1);
      expect(attendees[0]?.isHost).toBe(true);
    });
  });

  describe('admit / reject', () => {
    it('admits a waiting guest', async () => {
      const { rm, adapter } = build();
      const r = await rm.createRoom({ createdBy: 'host-1' });
      await rm.joinRoom(r.id, 'sock-host', 'Host', { userId: 'host-1' });
      await rm.joinRoom(r.id, 'sock-guest', 'Guest', { userId: 'guest-1' });
      expect(rm.getWaitingParticipants(r.id)).toHaveLength(1);

      const admitted = await rm.admitToRoom(r.id, 'sock-guest');
      expect(admitted.success).toBe(true);
      expect(rm.getWaitingParticipants(r.id)).toHaveLength(0);
      const participants = await adapter.getRoomParticipants(r.id);
      expect(participants.map((p) => p.name).sort()).toEqual(['Guest', 'Host']);
    });

    it('reject removes from queue and returns participant', async () => {
      const { rm } = build();
      const r = await rm.createRoom({ createdBy: 'host-1' });
      await rm.joinRoom(r.id, 'sock-guest', 'Guest', { userId: 'guest-1' });
      const rejected = rm.rejectWaiting(r.id, 'sock-guest');
      expect(rejected?.socketId).toBe('sock-guest');
      expect(rm.getWaitingParticipants(r.id)).toHaveLength(0);
    });

    it('admit fails if the socket is not waiting', async () => {
      const { rm } = build();
      const r = await rm.createRoom({ createdBy: 'host-1' });
      const result = await rm.admitToRoom(r.id, 'never-joined');
      expect(result.success).toBe(false);
    });
  });

  describe('leaveRoom + cleanup', () => {
    it('removes participant and tracks socket->room map', async () => {
      const { rm, adapter } = build();
      const r = await rm.createRoom({ createdBy: 'host-1', waitingRoom: false });
      await rm.joinRoom(r.id, 'sock-1', 'A', { userId: 'a' });
      expect(rm.findRoomBySocket('sock-1')).toBe(r.id);
      const left = await rm.leaveRoom(r.id, 'sock-1', { meetUserId: 'a' });
      expect(left?.name).toBe('A');
      expect(rm.findRoomBySocket('sock-1')).toBeNull();
      expect(await adapter.getRoomParticipants(r.id)).toHaveLength(0);
    });

    it('fires onMeetingProcessing after cleanup when room empties', async () => {
      const { rm, adapter, onMeetingProcessing } = build();
      const r = await rm.createRoom({ createdBy: 'host-1', waitingRoom: false });
      const joined = await rm.joinRoom(r.id, 'sock-1', 'A', { userId: 'a' });
      expect(joined.success).toBe(true);
      await rm.leaveRoom(r.id, 'sock-1', { meetUserId: 'a' });

      await new Promise((res) => setTimeout(res, 80));

      expect(onMeetingProcessing).toHaveBeenCalledTimes(1);
      expect(onMeetingProcessing.mock.calls[0]?.[0]?.roomId).toBe(r.id);
      expect(await adapter.getRoom(r.id)).toBeNull();
    });

    it('rejoining before cleanup cancels the timer', async () => {
      const { rm, onMeetingProcessing } = build();
      const r = await rm.createRoom({ createdBy: 'host-1', waitingRoom: false });
      await rm.joinRoom(r.id, 'sock-1', 'A', { userId: 'a' });
      await rm.leaveRoom(r.id, 'sock-1', { meetUserId: 'a' });

      await rm.joinRoom(r.id, 'sock-2', 'A2', { userId: 'a' });

      await new Promise((res) => setTimeout(res, 80));

      expect(onMeetingProcessing).not.toHaveBeenCalled();
    });
  });

  describe('getRoomCount', () => {
    it('returns the number of rooms tracked', async () => {
      const { rm } = build();
      expect(await rm.getRoomCount()).toBe(0);
      await rm.createRoom({});
      await rm.createRoom({});
      expect(await rm.getRoomCount()).toBe(2);
    });
  });
});
