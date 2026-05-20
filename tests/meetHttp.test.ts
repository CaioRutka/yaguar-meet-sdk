import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleMeetHttp } from '../src/server/http/meetHttp';
import { RoomManager } from '../src/server/RoomManager';
import { MemoryAdapter } from './_fixtures/MemoryAdapter';

let adapter: MemoryAdapter;
let roomManager: RoomManager;
let httpServer: HttpServer;
let baseUrl = '';

beforeAll(async () => {
  adapter = new MemoryAdapter();
  roomManager = new RoomManager(adapter, { maxParticipants: 4, cleanupTimeoutMs: 60_000 });
  httpServer = createServer(async (req, res) => {
    const handled = await handleMeetHttp(req, res, {
      adapter,
      roomManager,
      maxParticipants: 4,
      prefix: '/api',
    });
    if (!handled) {
      res.statusCode = 418;
      res.end();
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

describe('handleMeetHttp', () => {
  it('GET /api/health returns ok + uptime', async () => {
    const { status, json } = await request('GET', '/api/health');
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 'ok' });
    expect(typeof (json as { uptime: number }).uptime).toBe('number');
  });

  it('returns false (path not handled) when prefix does not match', async () => {
    const res = await fetch(`${baseUrl}/not-api/anything`);
    expect(res.status).toBe(418);
  });

  it('POST /api/rooms creates a room', async () => {
    const { status, json } = await request('POST', '/api/rooms', { createdBy: 'host-A' });
    expect(status).toBe(200);
    const roomId = (json as { roomId: string }).roomId;
    expect(roomId).toBeTruthy();
    expect(await adapter.getRoom(roomId)).not.toBeNull();
  });

  it('POST /api/rooms accepts waitingRoom override', async () => {
    const { status, json } = await request('POST', '/api/rooms', {
      createdBy: 'host-A',
      waitingRoom: false,
    });
    expect(status).toBe(200);
    const stored = await adapter.getRoom((json as { roomId: string }).roomId);
    expect(stored?.waitingRoom).toBe(false);
  });

  it('POST /api/rooms tolerates invalid JSON body and creates anonymous room', async () => {
    const res = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/rooms/:id returns the room or 404', async () => {
    const created = await request('POST', '/api/rooms', { createdBy: 'host-B' });
    const roomId = (created.json as { roomId: string }).roomId;
    const ok = await request('GET', `/api/rooms/${roomId}`);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ roomId });

    const nope = await request('GET', '/api/rooms/does-not-exist');
    expect(nope.status).toBe(404);
  });

  it('GET /api/rooms/:id/meetings lists meetings for a room', async () => {
    const created = await request('POST', '/api/rooms', { createdBy: 'host-C', waitingRoom: false });
    const roomId = (created.json as { roomId: string }).roomId;
    await adapter.saveMeeting({ roomId, status: 'completed' });
    const { status, json } = await request('GET', `/api/rooms/${roomId}/meetings`);
    expect(status).toBe(200);
    expect((json as { meetings: unknown[] }).meetings).toHaveLength(1);
  });

  it('GET /api/meetings/mine?userId=... aggregates by host/guest', async () => {
    const r = await adapter.createRoom({ createdBy: 'mine-host', waitingRoom: false });
    const m = await adapter.saveMeeting({ roomId: r.id });
    await adapter.addMeetingAttendee(m.id, {
      userId: 'mine-host',
      displayName: 'Mine',
      isHost: true,
      joinedAt: new Date().toISOString(),
    });

    const { status, json } = await request('GET', '/api/meetings/mine?userId=mine-host');
    expect(status).toBe(200);
    expect((json as { asHost: unknown[] }).asHost).toHaveLength(1);
  });

  it('GET /api/meetings/mine requires userId', async () => {
    const { status, json } = await request('GET', '/api/meetings/mine');
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/userId/);
  });

  it('GET /api/meetings/:id/detail respects participation (403 if not attended)', async () => {
    const r = await adapter.createRoom({ createdBy: 'host-D', waitingRoom: false });
    const m = await adapter.saveMeeting({ roomId: r.id });
    await adapter.addMeetingAttendee(m.id, {
      userId: 'host-D',
      displayName: 'D',
      isHost: true,
      joinedAt: new Date().toISOString(),
    });

    const forbidden = await request('GET', `/api/meetings/${m.id}/detail?userId=stranger`);
    expect(forbidden.status).toBe(403);

    const ok = await request('GET', `/api/meetings/${m.id}/detail?userId=host-D`);
    expect(ok.status).toBe(200);
    expect((ok.json as { isHost: boolean }).isHost).toBe(true);
  });

  it('GET /api/meetings/:id returns raw record or 404', async () => {
    const r = await adapter.createRoom({ createdBy: 'host-E', waitingRoom: false });
    const m = await adapter.saveMeeting({ roomId: r.id, status: 'completed' });
    const ok = await request('GET', `/api/meetings/${m.id}`);
    expect(ok.status).toBe(200);
    expect((ok.json as { id: string }).id).toBe(m.id);

    const nope = await request('GET', '/api/meetings/missing-id');
    expect(nope.status).toBe(404);
  });

  it('GET /api/meetings/:id/analysis returns 404 when no analysis', async () => {
    const r = await adapter.createRoom({ createdBy: 'host-F', waitingRoom: false });
    const m = await adapter.saveMeeting({ roomId: r.id });
    const { status } = await request('GET', `/api/meetings/${m.id}/analysis`);
    expect(status).toBe(404);

    await adapter.saveAnalysis({
      meetingId: m.id,
      overallScore: 7,
      summary: 's',
      strengths: ['a'],
      improvements: ['b'],
      feedback: 'f',
      parameterScores: {},
    });
    const after = await request('GET', `/api/meetings/${m.id}/analysis`);
    expect(after.status).toBe(200);
    expect((after.json as { overallScore: number }).overallScore).toBe(7);
  });

  it('POST /api/meetings/:id/schedule-return validates and returns 201', async () => {
    const r = await adapter.createRoom({ createdBy: 'host-G', waitingRoom: false });
    const m = await adapter.saveMeeting({ roomId: r.id });

    const bad = await request('POST', `/api/meetings/${m.id}/schedule-return`, { notes: 'no date' });
    expect(bad.status).toBe(400);

    const ok = await request('POST', `/api/meetings/${m.id}/schedule-return`, {
      scheduledFor: '2026-12-01T10:00:00Z',
      notes: 'follow up',
    });
    expect(ok.status).toBe(201);
    expect((ok.json as { id: string }).id).toBeTruthy();
  });

  it('GET /api/meetings/:id/schedule-returns lists returns', async () => {
    const r = await adapter.createRoom({ createdBy: 'host-H', waitingRoom: false });
    const m = await adapter.saveMeeting({ roomId: r.id });
    await adapter.saveScheduleReturn({ meetingId: m.id, scheduledFor: '2026-12-02T10:00Z' });

    const { status, json } = await request('GET', `/api/meetings/${m.id}/schedule-returns`);
    expect(status).toBe(200);
    expect((json as { scheduleReturns: unknown[] }).scheduleReturns).toHaveLength(1);
  });

  it('unknown subpath inside the API prefix returns 404', async () => {
    const { status, json } = await request('GET', '/api/totally-unknown');
    expect(status).toBe(404);
    expect((json as { error: string }).error).toBe('Not found');
  });

  it('httpAuth gate blocks request when it returns false', async () => {
    const guardedServer = createServer(async (req, res) => {
      await handleMeetHttp(req, res, {
        adapter,
        roomManager,
        maxParticipants: 4,
        prefix: '/api',
        httpAuth: async (_req, r) => {
          r.statusCode = 401;
          r.setHeader('Content-Type', 'application/json');
          r.end(JSON.stringify({ error: 'denied' }));
          return false;
        },
      });
    });
    await new Promise<void>((resolve) => guardedServer.listen(0, resolve));
    const port = (guardedServer.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => guardedServer.close(() => resolve()));
    }
  });
});
