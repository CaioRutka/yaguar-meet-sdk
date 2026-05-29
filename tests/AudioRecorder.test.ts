import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioRecorder } from '../src/client/AudioRecorder';

describe('AudioRecorder', () => {
  let recorder: AudioRecorder;
  let mockSignaling: any;
  let mockStream: any;
  let mockMediaRecorderInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSignaling = {
      startRecording: vi.fn(),
      appendRecordingChunk: vi.fn(),
      stopRecording: vi.fn(),
    };

    mockStream = {
      getAudioTracks: vi.fn().mockReturnValue([
        { readyState: 'live' },
      ]),
    };

    globalThis.MediaStream = class {
      constructor(tracks: any[]) {}
      getAudioTracks() {
        return [{ readyState: 'live' }];
      }
    } as any;

    mockMediaRecorderInstance = {
      start: vi.fn(),
      stop: vi.fn(),
      ondataavailable: null as any,
      onerror: null as any,
      mimeType: 'audio/webm',
      state: 'recording',
    };

    globalThis.MediaRecorder = class {
      static isTypeSupported = vi.fn().mockReturnValue(true);
      constructor(stream: any, opts?: any) {
        return mockMediaRecorderInstance as any;
      }
    } as any;

    recorder = new AudioRecorder(mockSignaling, {
      roomId: 'room-123',
      chunkIntervalMs: 500,
    });
  });

  it('deve instanciar o AudioRecorder corretamente', () => {
    expect(recorder).toBeDefined();
    expect(recorder.isRecording).toBe(false);
  });

  it('deve iniciar a gravação com sucesso', () => {
    const success = recorder.start(mockStream);

    expect(success).toBe(true);
    expect(recorder.isRecording).toBe(true);
    expect(mockMediaRecorderInstance.start).toHaveBeenCalledWith(500);
    expect(mockSignaling.startRecording).toHaveBeenCalledWith('room-123', 'audio/webm');
  });

  it('deve falhar ao iniciar se não houver tracks de áudio ativas', () => {
    const emptyStream = {
      getAudioTracks: vi.fn().mockReturnValue([]),
    };

    // Override global MediaStream getAudioTracks to return empty array
    globalThis.MediaStream = class {
      getAudioTracks() {
        return [];
      }
    } as any;

    const success = recorder.start(emptyStream as any);

    expect(success).toBe(false);
    expect(recorder.isRecording).toBe(false);
  });

  it('deve parar a gravação com sucesso', () => {
    recorder.start(mockStream);
    recorder.stop();

    expect(recorder.isRecording).toBe(false);
    expect(mockMediaRecorderInstance.stop).toHaveBeenCalled();
    expect(mockSignaling.stopRecording).toHaveBeenCalledWith('room-123');
  });
});
