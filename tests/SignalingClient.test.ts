import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalingClient } from '../src/client/SignalingClient';

const mockSocket = {
  on: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  removeAllListeners: vi.fn(),
  connected: false,
  id: 'socket-id-client-456',
};

vi.mock('socket.io-client', () => {
  return {
    io: vi.fn().mockImplementation(() => mockSocket),
  };
});

describe('SignalingClient', () => {
  let client: SignalingClient;
  const socketCallbacks: Record<string, any> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.on.mockImplementation((event, callback) => {
      socketCallbacks[event] = callback;
    });

    client = new SignalingClient({
      url: 'http://localhost:4000',
      autoConnect: true,
    });
  });

  it('deve instanciar o SignalingClient corretamente', () => {
    expect(client).toBeDefined();
    expect(client.socketId).toBe('socket-id-client-456');
    expect(client.rawSocket).toBe(mockSocket);
  });

  it('deve chamar connect no socket se não estiver conectado', () => {
    mockSocket.connected = false;
    client.connect();
    expect(mockSocket.connect).toHaveBeenCalled();
  });

  it('deve chamar disconnect no socket', () => {
    client.disconnect();
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it('deve emitir room:join ao se conectar a uma sala', () => {
    const payload = { roomId: 'room-1', name: 'Caio', userId: 'user-1' };
    client.joinRoom(payload);
    expect(mockSocket.emit).toHaveBeenCalledWith('room:join', payload);
  });

  it('deve emitir room:leave ao sair de uma sala', () => {
    client.leaveRoom();
    expect(mockSocket.emit).toHaveBeenCalledWith('room:leave');
  });

  it('deve emitir room:admit ao admitir participante', () => {
    client.admit('room-1', 'socket-2');
    expect(mockSocket.emit).toHaveBeenCalledWith('room:admit', { roomId: 'room-1', socketId: 'socket-2' });
  });

  it('deve emitir room:reject ao rejeitar participante', () => {
    client.reject('room-1', 'socket-2');
    expect(mockSocket.emit).toHaveBeenCalledWith('room:reject', { roomId: 'room-1', socketId: 'socket-2' });
  });

  it('deve emitir sinalização de offer', () => {
    client.sendOffer('socket-2', { sdp: 'offer-sdp' });
    expect(mockSocket.emit).toHaveBeenCalledWith('signal:offer', { to: 'socket-2', signal: { sdp: 'offer-sdp' } });
  });

  it('deve emitir sinalização de answer', () => {
    client.sendAnswer('socket-2', { sdp: 'answer-sdp' });
    expect(mockSocket.emit).toHaveBeenCalledWith('signal:answer', { to: 'socket-2', signal: { sdp: 'answer-sdp' } });
  });

  it('deve emitir sinalização de ice-candidate', () => {
    client.sendIceCandidate('socket-2', { candidate: 'candidate-data' });
    expect(mockSocket.emit).toHaveBeenCalledWith('signal:ice-candidate', { to: 'socket-2', signal: { candidate: 'candidate-data' } });
  });

  it('deve emitir chat:message', () => {
    client.sendChat('room-1', 'Olá');
    expect(mockSocket.emit).toHaveBeenCalledWith('chat:message', { roomId: 'room-1', message: 'Olá' });
  });

  it('deve emitir screen:sharing ao compartilhar tela', () => {
    client.broadcastScreenSharing('room-1', true);
    expect(mockSocket.emit).toHaveBeenCalledWith('screen:sharing', { roomId: 'room-1', isSharing: true });
  });

  it('deve emitir mic:speaking ao falar no microfone', () => {
    client.broadcastSpeaking('room-1', true);
    expect(mockSocket.emit).toHaveBeenCalledWith('mic:speaking', { roomId: 'room-1', speaking: true });
  });

  it('deve gerenciar comandos de gravação', () => {
    client.startRecording('room-1', 'audio/webm');
    expect(mockSocket.emit).toHaveBeenCalledWith('recording:start', { roomId: 'room-1', mimeType: 'audio/webm' });

    client.appendRecordingChunk('room-1', 'base64-chunk');
    expect(mockSocket.emit).toHaveBeenCalledWith('recording:chunk', { roomId: 'room-1', chunk: 'base64-chunk' });

    client.stopRecording('room-1');
    expect(mockSocket.emit).toHaveBeenCalledWith('recording:stop', { roomId: 'room-1' });
  });

  it('deve emitir agendamento de retorno', () => {
    const payload = { roomId: 'room-1', meetingId: 'meet-1', scheduledFor: '2026-12-10T15:00:00Z', notes: 'Notes' };
    client.scheduleReturn(payload);
    expect(mockSocket.emit).toHaveBeenCalledWith('schedule:return', payload);
  });

  it('deve propagar eventos do Socket interno para o Emitter tipado', () => {
    let fired = false;
    client.on('connect', () => {
      fired = true;
    });

    // Simular evento vindo do socket.io-client
    socketCallbacks['connect']();
    expect(fired).toBe(true);
  });

  it('deve limpar ouvintes e desconectar ao chamar dispose', () => {
    client.dispose();
    expect(mockSocket.removeAllListeners).toHaveBeenCalled();
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });
});
