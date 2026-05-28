import type { Server, Socket } from 'socket.io';
import type { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import type { IceServerConfig } from '../shared/types';
import type { YaguarMeetHooks } from './types';
import { RoomManager, type JoinRoomResult } from './RoomManager';
import { RecordingSessionManager } from './RecordingSessionManager';

export interface SignalingContext {
  roomManager: RoomManager;
  adapter: DatabaseAdapter;
  iceServers: IceServerConfig[];
  recording: RecordingSessionManager;
  hooks?: YaguarMeetHooks;
  requireRecording?: (userId: string) => Promise<boolean>;
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
}

type JoinOk = Extract<JoinRoomResult, { success: true }>;

async function completeJoinedSocketSession(
  io: Server,
  socket: Socket,
  ctx: SignalingContext,
  roomId: string,
  name: string,
  uid: string | undefined,
  result: JoinOk
): Promise<void> {
  socket.join(roomId);
  (socket.data as { roomId?: string; meetingId?: string }).roomId = roomId;
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

      await completeJoinedSocketSession(io, socket, ctx, roomId, name, uid, result);
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
      await completeJoinedSocketSession(io, target, ctx, roomId, pending.name, targetUid, result);
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


    socket.on('mic:speaking', ({ roomId, speaking }: { roomId: string; speaking: boolean }) => {
      const data = socket.data as { roomId?: string };
      if (!roomId || data.roomId !== roomId) return;
      socket.to(roomId).emit('mic:speaking', {
        socketId: socket.id,
        speaking: Boolean(speaking),
      });
    });

    socket.on('recording:start', async ({ roomId, mimeType }: RecordingPayload) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) {
        socket.emit('recording:error', { message: 'Apenas o anfitrião pode gravar para IA.' });
        return;
      }
      const mid = (socket.data as { meetingId?: string }).meetingId;
      const key = mid ?? roomId;
      try {
        await ctx.recording.start(key, mimeType || 'audio/webm');
      } catch (e) {
        console.error('[Socket] recording:start', e);
        socket.emit('recording:error', { message: 'Não foi possível iniciar a gravação.' });
      }
    });

    socket.on('recording:chunk', async ({ roomId, chunk }: RecordingPayload) => {
      if (!chunk) return;
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) return;
      const mid = (socket.data as { meetingId?: string }).meetingId;
      const key = mid ?? roomId;
      ctx.recording.appendChunk(key, Buffer.from(chunk, 'base64'));
    });

    // Client stops the MediaRecorder — finalize the active segment on the server.
    socket.on('recording:stop', async ({ roomId }: RecordingPayload) => {
      if (!(await isMeetingHost(ctx.adapter, socket, roomId))) return;
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
          console.error('[Socket] recording:stop requireRecording', e);
        }
      }
      const mid = (socket.data as { meetingId?: string }).meetingId;
      const key = mid ?? roomId;
      try {
        await ctx.recording.pause(key);
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
      try {
        const row = await ctx.adapter.saveScheduleReturn({
          meetingId: payload.meetingId,
          scheduledFor: payload.scheduledFor,
          notes: payload.notes ?? null,
        });
        io.in(payload.roomId).emit('schedule:return:confirmed', row);
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
