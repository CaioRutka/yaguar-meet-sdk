import type { Server, Socket } from 'socket.io';
import type { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import type { IceServerConfig } from '../shared/types';
import type { YaguarMeetConfig, YaguarMeetHooks } from './types';
import { RoomManager, type JoinRoomResult } from './RoomManager';
import { RecordingSessionManager } from './RecordingSessionManager';

export interface SignalingContext {
  roomManager: RoomManager;
  adapter: DatabaseAdapter;
  iceServers: IceServerConfig[];
  recording: RecordingSessionManager;
  hooks?: YaguarMeetHooks;
  requireRecording?: (userId: string) => Promise<boolean>;
  onScheduleReturn?: YaguarMeetConfig['onScheduleReturn'];
}

interface JoinPayload {
  roomId: string;
  name: string;
  userId?: string;
}

interface SignalPayload {
  to: string;
  signal: unknown;
}

interface ChatPayload {
  roomId: string;
  message: string;
}

interface RecordingPayload {
  roomId: string;
  mimeType?: string;
  chunk?: string;
}

interface SchedulePayload {
  roomId: string;
  meetingId: string;
  scheduledFor: string;
  notes?: string;
  hostEmail: string;
  guestEmail: string;
  durationMinutes?: number;
}

type JoinOk = Extract<JoinRoomResult, { success: true }>;

async function completeJoinedSocketSession(
  io: Server,
  socket: Socket,
  ctx: SignalingContext,
  roomId: string,
  name: string,
  uid: string | undefined,
  result: JoinOk,
  recordingActive: Map<string, boolean>
): Promise<void> {
  socket.join(roomId);
  (socket.data as { roomId?: string; meetingId?: string; name?: string }).roomId = roomId;
  (socket.data as { name?: string }).name = name;
  if (result.meetingId) {
    (socket.data as { meetingId?: string }).meetingId = result.meetingId;
  }

  const roomRow = await ctx.adapter.getRoom(roomId);
  const isHost = Boolean(uid && roomRow?.createdBy === uid);

  let requireRecording = false;
  if (isHost && uid && ctx.requireRecording) {
    try {
      requireRecording = await ctx.requireRecording(uid);
    } catch (e) {
      console.error('[Socket] requireRecording lookup', e);
    }
  }

  socket.emit('room:participants', {
    participants: result.participants.map((p) => ({
      socketId: p.socketId,
      name: p.name,
    })),
    meetingId: result.meetingId,
    isHost,
  });

  socket.emit('room:session', { roomId, meetingId: result.meetingId, isHost, requireRecording });

  socket.to(roomId).emit('user:joined', {
    socketId: socket.id,
    name,
  });

  if (isHost) {
    const waiting = ctx.roomManager.getWaitingParticipants(roomId);
    if (waiting.length) {
      socket.emit('room:admission-sync', { waiting });
    }
  }

  // Tell late joiners whether the meeting is already being recorded for AI, so
  // their client starts capturing its own microphone for speaker attribution.
  const recKey = result.meetingId ?? roomId;
  if (recordingActive.get(recKey)) {
    socket.emit('recording:active', { active: true });
  }

  try {
    await ctx.hooks?.onJoin?.({
      roomId,
      socketId: socket.id,
      name,
      meetingId: result.meetingId ?? null,
    });
  } catch (e) {
    console.error('[Socket] onJoin hook', e);
  }

  console.log(`[Socket] ${name} joined room ${roomId}`);
}

export function registerSocketHandlers(io: Server, ctx: SignalingContext) {
  // Meeting-level "recording for AI" state, keyed by meetingId (fallback roomId).
  // The host toggles it; all participants capture their own mic while active.
  const recordingActive = new Map<string, boolean>();

  const recordingKey = (socket: Socket, roomId: string): string => {
    const mid = (socket.data as { meetingId?: string }).meetingId;
    return mid ?? roomId;
  };

  io.on('connection', (socket: Socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);
    socket.emit('config:ice-servers', ctx.iceServers);

    socket.on('room:join', async ({ roomId, name, userId }: JoinPayload) => {
      const uid = typeof userId === 'string' ? userId.trim().slice(0, 128) : undefined;
      (socket.data as { meetUserId?: string }).meetUserId = uid;

      const result = await ctx.roomManager.joinRoom(roomId, socket.id, name, { userId: uid });

      if (!result.success) {
        if ('waiting' in result && result.waiting) {
          (socket.data as { pendingRoomId?: string }).pendingRoomId = roomId;
          socket.emit('room:waiting', { roomId });
          socket.to(roomId).emit('room:admission-request', {
            socketId: socket.id,
            name,
            userId: uid,
          });
          return;
        }
        const errMsg = 'error' in result ? result.error : 'Não foi possível entrar na sala.';
        socket.emit('room:error', { message: errMsg });
        return;
      }

      await completeJoinedSocketSession(io, socket, ctx, roomId, name, uid, result, recordingActive);
    });

    socket.on('room:admit', async ({ roomId, socketId }: { roomId: string; socketId: string }) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('room:error', { message: 'Apenas o anfitrião pode aprovar entrada.' });
        return;
      }
      const pending = ctx.roomManager.getWaitingParticipant(roomId, socketId);
      if (!pending) return;

      const target = io.sockets.sockets.get(socketId);
      if (!target) {
        ctx.roomManager.removeFromWaitingQueue(roomId, socketId);
        return;
      }

      const result = await ctx.roomManager.admitToRoom(roomId, socketId);
      if (!result.success) {
        const msg =
          'error' in result && typeof result.error === 'string'
            ? result.error
            : 'Falha ao admitir participante.';
        socket.emit('room:error', { message: msg });
        return;
      }

      delete (target.data as { pendingRoomId?: string }).pendingRoomId;
      const targetUid = (target.data as { meetUserId?: string }).meetUserId?.trim();
      target.emit('room:admitted', { roomId });
      await completeJoinedSocketSession(io, target, ctx, roomId, pending.name, targetUid, result, recordingActive);
    });

    socket.on('room:reject', async ({ roomId, socketId }: { roomId: string; socketId: string }) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('room:error', { message: 'Apenas o anfitrião pode recusar entrada.' });
        return;
      }
      const removed = ctx.roomManager.rejectWaiting(roomId, socketId);
      if (!removed) return;
      const target = io.sockets.sockets.get(socketId);
      if (target) {
        delete (target.data as { pendingRoomId?: string }).pendingRoomId;
        target.emit('room:rejected', { message: 'O anfitrião recusou sua entrada.' });
      }
    });

    socket.on('room:leave', () => {
      const pending = (socket.data as { pendingRoomId?: string }).pendingRoomId;
      if (pending) {
        ctx.roomManager.removeFromWaitingQueue(pending, socket.id);
        delete (socket.data as { pendingRoomId?: string }).pendingRoomId;
        return;
      }
      void handleDisconnect(socket, io, ctx);
    });

    socket.on('signal:offer', ({ to, signal }: SignalPayload) => {
      io.to(to).emit('signal:offer', { from: socket.id, signal });
    });

    socket.on('signal:answer', ({ to, signal }: SignalPayload) => {
      io.to(to).emit('signal:answer', { from: socket.id, signal });
    });

    socket.on('signal:ice-candidate', ({ to, signal }: SignalPayload) => {
      io.to(to).emit('signal:ice-candidate', { from: socket.id, signal });
    });

    socket.on('chat:message', async ({ roomId, message }: ChatPayload) => {
      const exists = await ctx.roomManager.roomExists(roomId);
      if (!exists) return;

      const participants = await ctx.adapter.getRoomParticipants(roomId);
      const participant = participants.find((p) => p.socketId === socket.id);
      if (!participant) return;

      const chatMsg = {
        id: `${socket.id}-${Date.now()}`,
        sender: participant.name,
        senderId: socket.id,
        message,
        timestamp: new Date().toISOString(),
      };

      io.in(roomId).emit('chat:message', chatMsg);
    });

    socket.on('screen:sharing', ({ roomId, isSharing }: { roomId: string; isSharing: boolean }) => {
      socket.to(roomId).emit('screen:sharing', {
        socketId: socket.id,
        isSharing,
      });
    });

    socket.on('room:mute-user', async ({ roomId, targetSocketId }: { roomId: string; targetSocketId: string }) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('room:error', { message: 'Apenas o anfitrião pode mutar participantes.' });
        return;
      }
      const target = io.sockets.sockets.get(targetSocketId);
      if (target) {
        target.emit('room:muted-by-host', { roomId });
      }
    });

    socket.on('room:remove-user', async ({ roomId, targetSocketId }: { roomId: string; targetSocketId: string }) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('room:error', { message: 'Apenas o anfitrião pode remover participantes.' });
        return;
      }
      const target = io.sockets.sockets.get(targetSocketId);
      if (target) {
        target.emit('room:removed-by-host', { roomId });
        target.disconnect(true);
      }
    });

    socket.on('room:end', async ({ roomId }: { roomId: string }) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('room:error', { message: 'Apenas o anfitrião pode encerrar a reunião.' });
        return;
      }
      socket.to(roomId).emit('room:ended-by-host');
      const sockets = await io.in(roomId).fetchSockets();
      for (const s of sockets) {
        if (s.id !== socket.id) s.disconnect(true);
      }
    });


    socket.on('mic:speaking', ({ roomId, speaking }: { roomId: string; speaking: boolean }) => {
      const data = socket.data as { roomId?: string };
      if (!roomId || data.roomId !== roomId) return;
      socket.to(roomId).emit('mic:speaking', {
        socketId: socket.id,
        speaking: Boolean(speaking),
      });
    });

    socket.on('mic:muted', ({ roomId, muted }: { roomId: string; muted: boolean }) => {
      const data = socket.data as { roomId?: string };
      if (!roomId || data.roomId !== roomId) return;
      socket.to(roomId).emit('mic:muted', {
        socketId: socket.id,
        muted: Boolean(muted),
      });
    });

    // Host enables AI recording for the whole meeting. Every participant then
    // captures their own microphone (see `recording:start`).
    socket.on('recording:enable', async ({ roomId }: RecordingPayload) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('recording:error', { message: 'Apenas o anfitrião pode gravar para IA.' });
        return;
      }
      const key = recordingKey(socket, roomId);
      recordingActive.set(key, true);
      io.in(roomId).emit('recording:active', { active: true });
    });

    // Host disables AI recording for the meeting (blocked when mandatory).
    socket.on('recording:disable', async ({ roomId }: RecordingPayload) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('recording:error', { message: 'Apenas o anfitrião pode gravar para IA.' });
        return;
      }
      const uid = (socket.data as { meetUserId?: string }).meetUserId;
      if (uid && ctx.requireRecording) {
        try {
          if (await ctx.requireRecording(uid)) {
            socket.emit('recording:error', {
              message: 'A gravação é obrigatória nesta conta e não pode ser pausada.',
            });
            return;
          }
        } catch (e) {
          console.error('[Socket] recording:disable requireRecording', e);
        }
      }
      const key = recordingKey(socket, roomId);
      recordingActive.set(key, false);
      io.in(roomId).emit('recording:active', { active: false });
    });

    // A participant starts capturing their own microphone. Allowed only while
    // the meeting recording is active. Audio is tracked per participant so the
    // transcript can attribute each line to who spoke it.
    socket.on('recording:start', async ({ roomId, mimeType }: RecordingPayload) => {
      const data = socket.data as { roomId?: string };
      if (data.roomId !== roomId) return;
      const key = recordingKey(socket, roomId);
      if (!recordingActive.get(key)) return;
      const speaker = (socket.data as { name?: string }).name?.trim() || 'Participante';
      const speakerId = (socket.data as { meetUserId?: string }).meetUserId?.trim() || socket.id;
      try {
        await ctx.recording.start(key, {
          participantKey: socket.id,
          speaker,
          speakerId,
          mimeType: mimeType || 'audio/webm',
        });
      } catch (e) {
        console.error('[Socket] recording:start', e);
        socket.emit('recording:error', { message: 'Não foi possível iniciar a gravação.' });
      }
    });

    socket.on('recording:chunk', ({ roomId, chunk }: RecordingPayload) => {
      if (!chunk) return;
      const data = socket.data as { roomId?: string };
      if (data.roomId !== roomId) return;
      const key = recordingKey(socket, roomId);
      if (!recordingActive.get(key)) return;
      ctx.recording.appendChunk(key, socket.id, Buffer.from(chunk, 'base64'));
    });

    // Client stops its MediaRecorder — finalize this participant's active segment.
    socket.on('recording:stop', async ({ roomId }: RecordingPayload) => {
      const data = socket.data as { roomId?: string };
      if (data.roomId !== roomId) return;
      const key = recordingKey(socket, roomId);
      try {
        await ctx.recording.pauseParticipant(key, socket.id);
      } catch (e) {
        console.error('[Socket] recording:stop', e);
        socket.emit('recording:error', { message: 'Não foi possível pausar a gravação.' });
      }
    });

    socket.on('schedule:return', async (payload: SchedulePayload) => {
      if (!(await isMeetingHost(ctx.adapter, socket, payload.roomId))) {
        socket.emit('schedule:return:error', { message: 'Apenas o anfitrião pode agendar retorno.' });
        return;
      }

      const hostEmail = typeof payload.hostEmail === 'string' ? payload.hostEmail.trim().toLowerCase() : '';
      const guestEmail = typeof payload.guestEmail === 'string' ? payload.guestEmail.trim().toLowerCase() : '';
      if (!hostEmail || !hostEmail.includes('@')) {
        socket.emit('schedule:return:error', { message: 'Informe seu e-mail cadastrado no Yaguar Agenda.' });
        return;
      }
      if (!guestEmail || !guestEmail.includes('@')) {
        socket.emit('schedule:return:error', { message: 'Informe o e-mail do convidado.' });
        return;
      }
      if (hostEmail === guestEmail) {
        socket.emit('schedule:return:error', { message: 'O e-mail do convidado deve ser diferente do seu.' });
        return;
      }

      try {
        const meetHostUserId = (socket.data as { meetUserId?: string }).meetUserId?.trim() ?? null;
        let agendaHostEventId: string | null = null;
        let agendaGuestEventId: string | null = null;
        let agendaMeetingLink: string | null = null;
        let agendaMessage: string | undefined;

        if (ctx.onScheduleReturn) {
          try {
            const agenda = await ctx.onScheduleReturn({
              meetingId: payload.meetingId,
              roomId: payload.roomId,
              scheduledFor: payload.scheduledFor,
              notes: payload.notes ?? null,
              hostEmail,
              guestEmail,
              meetHostUserId,
            });
            agendaHostEventId = agenda.agendaHostEventId ?? null;
            agendaGuestEventId = agenda.agendaGuestEventId ?? null;
            agendaMeetingLink = agenda.agendaMeetingLink ?? null;
            agendaMessage = agenda.message;
          } catch (agendaErr) {
            const msg = agendaErr instanceof Error ? agendaErr.message : String(agendaErr);
            socket.emit('schedule:return:error', { message: msg });
            return;
          }
        }

        const row = await ctx.adapter.saveScheduleReturn({
          meetingId: payload.meetingId,
          scheduledFor: payload.scheduledFor,
          notes: payload.notes ?? null,
          hostEmail,
          guestEmail,
          agendaHostEventId,
          agendaGuestEventId,
          agendaMeetingLink,
        });

        io.in(payload.roomId).emit('schedule:return:confirmed', {
          ...row,
          agendaMessage,
        });
      } catch (e) {
        socket.emit('schedule:return:error', { message: String(e) });
      }
    });

    socket.on('disconnect', () => {
      const pending = (socket.data as { pendingRoomId?: string }).pendingRoomId;
      if (pending) {
        ctx.roomManager.removeFromWaitingQueue(pending, socket.id);
        const waiting = ctx.roomManager.getWaitingParticipants(pending);
        io.in(pending).emit('room:admission-sync', { waiting });
      } else {
        void handleDisconnect(socket, io, ctx);
      }
      console.log(`[Socket] Disconnected: ${socket.id}`);
    });
  });
}

async function isMeetingHost(adapter: DatabaseAdapter, socket: Socket, roomId: string): Promise<boolean> {
  const userId = (socket.data as { meetUserId?: string }).meetUserId?.trim();
  if (!userId) return false;
  const room = await adapter.getRoom(roomId);
  return Boolean(room?.createdBy && room.createdBy === userId);
}

async function handleDisconnect(socket: Socket, io: Server, ctx: SignalingContext) {
  const roomId = ctx.roomManager.findRoomBySocket(socket.id);
  if (!roomId) return;

  const participant = await ctx.roomManager.leaveRoom(roomId, socket.id, {
    meetUserId: (socket.data as { meetUserId?: string }).meetUserId,
  });
  if (!participant) return;

  socket.leave(roomId);

  // Flush this participant's in-progress recording so their audio isn't lost.
  const recKey = (socket.data as { meetingId?: string }).meetingId ?? roomId;
  void ctx.recording.pauseParticipant(recKey, socket.id).catch((e) => {
    console.error('[Socket] disconnect pauseParticipant', e);
  });

  io.in(roomId).emit('user:left', {
    socketId: socket.id,
    name: participant.name,
  });

  try {
    await ctx.hooks?.onLeave?.({
      roomId,
      socketId: socket.id,
      name: participant.name,
      meetingId: (socket.data as { meetingId?: string }).meetingId ?? null,
    });
  } catch (e) {
    console.error('[Socket] onLeave hook', e);
  }
}
