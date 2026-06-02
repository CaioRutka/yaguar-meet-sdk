import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSocketHandlers } from '../src/server/registerSocketHandlers';

describe('registerSocketHandlers', () => {
  let mockIo: any;
  let mockSocket: any;
  let mockCtx: any;
  let connectionHandler: any;
  const socketHandlers: Record<string, any> = {};

  beforeEach(() => {
    vi.clearAllMocks();

    mockIo = {
      on: vi.fn().mockImplementation((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      }),
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      in: vi.fn().mockReturnValue({ emit: vi.fn() }),
      sockets: {
        sockets: {
          get: vi.fn(),
        },
      },
    };

    mockSocket = {
      id: 'socket-client-123',
      data: {},
      on: vi.fn().mockImplementation((event, handler) => {
        socketHandlers[event] = handler;
      }),
      emit: vi.fn(),
      join: vi.fn(),
      leave: vi.fn(),
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      disconnect: vi.fn(),
    };

    mockCtx = {
      roomManager: {
        joinRoom: vi.fn().mockResolvedValue({
          success: true,
          meetingId: 'meet-123',
          participants: [{ socketId: 'socket-client-123', name: 'Caio' }],
        }),
        getWaitingParticipants: vi.fn().mockReturnValue([]),
        leaveRoom: vi.fn().mockResolvedValue({ name: 'Caio' }),
        findRoomBySocket: vi.fn().mockReturnValue('room-123'),
        roomExists: vi.fn().mockResolvedValue(true),
        getWaitingParticipant: vi.fn(),
        admitToRoom: vi.fn(),
        rejectWaiting: vi.fn(),
        removeFromWaitingQueue: vi.fn(),
      },
      adapter: {
        getRoom: vi.fn().mockResolvedValue({ id: 'room-123', createdBy: 'user-host-123' }),
        getRoomParticipants: vi.fn().mockResolvedValue([
          { socketId: 'socket-client-123', name: 'Caio' },
        ]),
        saveScheduleReturn: vi.fn().mockResolvedValue({ id: 'schedule-123' }),
      },
      iceServers: [{ urls: 'stun:stun.l.google.com' }],
      recording: {
        start: vi.fn().mockResolvedValue(undefined),
        appendChunk: vi.fn(),
        pause: vi.fn().mockResolvedValue(undefined),
      },
      hooks: {
        onJoin: vi.fn().mockResolvedValue(undefined),
        onLeave: vi.fn().mockResolvedValue(undefined),
      },
      requireRecording: vi.fn().mockResolvedValue(false),
    };

    // Registrar os handlers
    registerSocketHandlers(mockIo, mockCtx);
    // Simular conexão
    if (connectionHandler) {
      connectionHandler(mockSocket);
    }
  });

  it('deve enviar as configurações de ICE Servers na conexão', () => {
    expect(mockSocket.emit).toHaveBeenCalledWith('config:ice-servers', mockCtx.iceServers);
  });

  it('deve registrar os eventos principais do Socket no cliente', () => {
    expect(socketHandlers['room:join']).toBeDefined();
    expect(socketHandlers['chat:message']).toBeDefined();
    expect(socketHandlers['mic:speaking']).toBeDefined();
    expect(socketHandlers['disconnect']).toBeDefined();
  });

  it('deve gerenciar a entrada em sala (room:join)', async () => {
    await socketHandlers['room:join']({ roomId: 'room-123', name: 'Caio', userId: 'user-host-123' });

    expect(mockCtx.roomManager.joinRoom).toHaveBeenCalledWith('room-123', 'socket-client-123', 'Caio', {
      userId: 'user-host-123',
    });
    expect(mockSocket.join).toHaveBeenCalledWith('room-123');
    expect(mockSocket.emit).toHaveBeenCalledWith('room:session', expect.objectContaining({
      roomId: 'room-123',
      meetingId: 'meet-123',
      isHost: true,
    }));
  });

  it('deve propagar mensagens de chat (chat:message)', async () => {
    await socketHandlers['chat:message']({ roomId: 'room-123', message: 'Olá, mundo' });

    expect(mockCtx.roomManager.roomExists).toHaveBeenCalledWith('room-123');
    expect(mockCtx.adapter.getRoomParticipants).toHaveBeenCalledWith('room-123');
    expect(mockIo.in).toHaveBeenCalledWith('room-123');
  });

  it('deve iniciar gravação de áudio (recording:start)', async () => {
    mockSocket.data = { meetUserId: 'user-host-123', meetingId: 'meet-123' };

    await socketHandlers['recording:start']({ roomId: 'room-123' });

    expect(mockCtx.recording.start).toHaveBeenCalledWith('meet-123', 'audio/webm');
  });

  it('deve anexar chunks de áudio em base64 (recording:chunk)', async () => {
    mockSocket.data = { meetUserId: 'user-host-123', meetingId: 'meet-123' };

    const base64Chunk = Buffer.from('dummy-audio-data').toString('base64');
    await socketHandlers['recording:chunk']({ roomId: 'room-123', chunk: base64Chunk });

    expect(mockCtx.recording.appendChunk).toHaveBeenCalledWith('meet-123', expect.any(Buffer));
  });

  it('deve pausar a gravação de áudio (recording:stop)', async () => {
    mockSocket.data = { meetUserId: 'user-host-123', meetingId: 'meet-123' };

    await socketHandlers['recording:stop']({ roomId: 'room-123' });

    expect(mockCtx.recording.pause).toHaveBeenCalledWith('meet-123');
  });

  it('deve emitir o status de fala no microfone (mic:speaking)', async () => {
    mockSocket.data = { roomId: 'room-123' };

    await socketHandlers['mic:speaking']({ roomId: 'room-123', speaking: true });

    expect(mockSocket.to).toHaveBeenCalledWith('room-123');
  });

  it('deve agendar o retorno da reunião (schedule:return)', async () => {
    mockSocket.data = { meetUserId: 'user-host-123' };

    await socketHandlers['schedule:return']({
      roomId: 'room-123',
      meetingId: 'meet-123',
      scheduledFor: '2026-12-10T15:00:00Z',
      notes: 'Test note',
      hostEmail: 'host@example.com',
      guestEmail: 'guest@example.com',
    });

    expect(mockCtx.adapter.saveScheduleReturn).toHaveBeenCalledWith({
      meetingId: 'meet-123',
      scheduledFor: '2026-12-10T15:00:00Z',
      notes: 'Test note',
      hostEmail: 'host@example.com',
      guestEmail: 'guest@example.com',
      agendaHostEventId: null,
      agendaGuestEventId: null,
      agendaMeetingLink: null,
    });
  });

  it('deve processar desconexão (disconnect)', async () => {
    await socketHandlers['disconnect']();

    expect(mockCtx.roomManager.findRoomBySocket).toHaveBeenCalledWith('socket-client-123');
    expect(mockCtx.roomManager.leaveRoom).toHaveBeenCalledWith('room-123', 'socket-client-123', expect.any(Object));
    expect(mockSocket.leave).toHaveBeenCalledWith('room-123');
  });
});
