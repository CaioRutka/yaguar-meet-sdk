import type { IncomingMessage, ServerResponse } from 'http';
import type { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import type { RoomManager } from '../RoomManager';
import {
  parsePath,
  parseQuery,
  pathUnderPrefix,
  readJsonBody,
  segments,
  sendJson,
  serializeErrorForHttp,
} from './httpUtil';

export interface MeetHttpOptions {
  roomManager: RoomManager;
  adapter: DatabaseAdapter;
  maxParticipants: number;
  /** Default `/api` */
  prefix?: string;
  /** Return `true` to continue; `false` if auth failed and response was sent */
  httpAuth?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

/**
 * Framework-agnostic REST for Yaguar Meet (Node `http` only).
 * Returns whether a matching route was handled (including 404 within the API prefix).
 */
export async function handleMeetHttp(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MeetHttpOptions
): Promise<boolean> {
  const pathname = parsePath(req.url);
  const prefix = opts.prefix ?? '/api';
  const sub = pathUnderPrefix(pathname, prefix);
  if (sub === null) return false;

  if (opts.httpAuth) {
    const ok = await opts.httpAuth(req, res);
    if (!ok) return true;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const segs = segments(sub);

  try {
    if (method === 'GET' && segs.length === 1 && segs[0] === 'health') {
      const rooms = await opts.roomManager.getRoomCount();
      sendJson(res, 200, { status: 'ok', rooms, uptime: process.uptime() });
      return true;
    }

    if (method === 'POST' && segs.length === 1 && segs[0] === 'rooms') {
      let createdBy: string | undefined;
      let waitingRoom: boolean | undefined;
      try {
        const body = (await readJsonBody(req)) as { createdBy?: string; waitingRoom?: boolean };
        createdBy = typeof body?.createdBy === 'string' ? body.createdBy.trim().slice(0, 128) : undefined;
        if (typeof body?.waitingRoom === 'boolean') waitingRoom = body.waitingRoom;
      } catch {
        createdBy = undefined;
      }
      const room = await opts.roomManager.createRoom({
        ...(createdBy ? { createdBy } : {}),
        ...(waitingRoom !== undefined ? { waitingRoom } : {}),
      });
      sendJson(res, 200, { roomId: room.id, createdAt: room.createdAt });
      return true;
    }

    if (method === 'GET' && segs.length === 2 && segs[0] === 'rooms') {
      const id = segs[1];
      const room = await opts.roomManager.getRoom(id);
      if (!room) {
        sendJson(res, 404, { error: 'Room not found' });
        return true;
      }
      const count = (await opts.roomManager.getParticipants(id)).length;
      sendJson(res, 200, {
        roomId: room.id,
        participantCount: count,
        maxParticipants: room.maxParticipants ?? opts.maxParticipants,
        createdAt: room.createdAt,
        waitingRoom: room.waitingRoom !== false,
      });
      return true;
    }

    if (method === 'GET' && segs.length === 3 && segs[0] === 'rooms' && segs[2] === 'meetings') {
      const roomId = segs[1];
      const list = await opts.adapter.getMeetingsByRoom(roomId);
      sendJson(res, 200, { meetings: list });
      return true;
    }

    if (method === 'GET' && segs.length === 2 && segs[0] === 'meetings' && segs[1] === 'mine') {
      const q = parseQuery(req.url);
      const userId = q.userId?.trim();
      if (!userId) {
        sendJson(res, 400, { error: 'userId query parameter is required' });
        return true;
      }
      const list = await opts.adapter.listMeetingsForUser(userId.slice(0, 128));
      const asHost = list.filter((x) => x.isHost);
      const asGuest = list.filter((x) => !x.isHost);
      sendJson(res, 200, { meetings: list, asHost, asGuest });
      return true;
    }

    if (method === 'GET' && segs.length === 3 && segs[0] === 'meetings' && segs[2] === 'detail') {
      const meetingId = segs[1];
      const q = parseQuery(req.url);
      const userId = q.userId?.trim();
      if (!userId) {
        sendJson(res, 400, { error: 'userId query parameter is required' });
        return true;
      }
      const attendees = await opts.adapter.getMeetingAttendees(meetingId);
      const self = attendees.find((a) => a.userId === userId.slice(0, 128));
      if (!self) {
        sendJson(res, 403, { error: 'Você não participou desta reunião.' });
        return true;
      }
      const meeting = await opts.adapter.getMeeting(meetingId);
      if (!meeting) {
        sendJson(res, 404, { error: 'Meeting not found' });
        return true;
      }
      const analysis = self.isHost ? await opts.adapter.getAnalysisByMeeting(meetingId) : null;
      const scheduleReturns = self.isHost
        ? await opts.adapter.getScheduleReturnsByMeeting(meetingId)
        : [];
      const analysisFallback =
        typeof meeting.metadata?.analysisFallback === 'string' ? meeting.metadata.analysisFallback : null;
      const meetingOut: typeof meeting = self.isHost
        ? meeting
        : { ...meeting, transcript: null, metadata: meeting.metadata };
      sendJson(res, 200, {
        meeting: meetingOut,
        attendees,
        analysis,
        scheduleReturns,
        isHost: self.isHost,
        analysisFallback: self.isHost ? analysisFallback : null,
      });
      return true;
    }

    if (method === 'GET' && segs.length === 2 && segs[0] === 'meetings') {
      const meetingId = segs[1];
      const m = await opts.adapter.getMeeting(meetingId);
      if (!m) {
        sendJson(res, 404, { error: 'Meeting not found' });
        return true;
      }
      sendJson(res, 200, m);
      return true;
    }

    if (method === 'GET' && segs.length === 3 && segs[0] === 'meetings' && segs[2] === 'analysis') {
      const meetingId = segs[1];
      const a = await opts.adapter.getAnalysisByMeeting(meetingId);
      if (!a) {
        sendJson(res, 404, { error: 'Analysis not found' });
        return true;
      }
      sendJson(res, 200, a);
      return true;
    }

    if (method === 'POST' && segs.length === 3 && segs[0] === 'meetings' && segs[2] === 'schedule-return') {
      const meetingId = segs[1];
      const body = (await readJsonBody(req)) as { scheduledFor?: string; notes?: string };
      if (!body?.scheduledFor) {
        sendJson(res, 400, { error: 'scheduledFor is required (ISO date string)' });
        return true;
      }
      const row = await opts.adapter.saveScheduleReturn({
        meetingId,
        scheduledFor: body.scheduledFor,
        notes: body.notes ?? null,
      });
      sendJson(res, 201, row);
      return true;
    }

    if (method === 'GET' && segs.length === 3 && segs[0] === 'meetings' && segs[2] === 'schedule-returns') {
      const meetingId = segs[1];
      const list = await opts.adapter.getScheduleReturnsByMeeting(meetingId);
      sendJson(res, 200, { scheduleReturns: list });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (e) {
    console.error('[meetHttp]', e);
    sendJson(res, 500, serializeErrorForHttp(e));
    return true;
  }
}
