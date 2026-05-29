import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpeakingDetector } from '../src/client/SpeakingDetector';

describe('SpeakingDetector', () => {
  let detector: SpeakingDetector;
  let mockAnalyser: any;
  let mockAudioContext: any;
  let mockStream: any;

  beforeEach(() => {
    vi.useFakeTimers();

    mockAnalyser = {
      fftSize: 1024,
      frequencyBinCount: 512,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteTimeDomainData: vi.fn().mockImplementation((arr: Uint8Array) => {
        arr.fill(128); // silent by default (baseline 128)
      }),
    };

    mockAudioContext = {
      createMediaStreamSource: vi.fn().mockReturnValue({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
      close: vi.fn().mockResolvedValue(undefined),
    };

    globalThis.AudioContext = vi.fn().mockImplementation(() => mockAudioContext) as any;

    mockStream = {
      getAudioTracks: vi.fn().mockReturnValue([]),
    };

    detector = new SpeakingDetector({
      threshold: 0.04,
      intervalMs: 100,
      debounceMs: 150,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    detector.dispose();
  });

  it('deve instanciar com opções padrão', () => {
    expect(detector).toBeDefined();
    expect(detector.isSpeaking).toBe(false);
  });

  it('deve iniciar a detecção com sucesso e criar AudioContext', () => {
    detector.start(mockStream);

    expect(globalThis.AudioContext).toHaveBeenCalled();
    expect(mockAudioContext.createAnalyser).toHaveBeenCalled();
  });

  it('deve detectar fala se o RMS exceder o threshold', () => {
    detector.start(mockStream);

    // Mudar dados do analyser para som alto (ex: 200)
    mockAnalyser.getByteTimeDomainData.mockImplementationOnce((arr: Uint8Array) => {
      arr.fill(200); // 200 - 128 = 72, RMS alto
    });

    let detectedSpeaking: boolean | null = null;
    detector.on('change', (val) => {
      detectedSpeaking = val;
    });

    // Avance o timer para disparar o sample
    vi.advanceTimersByTime(100);

    // Avance mais que o debounceMs (150ms)
    vi.advanceTimersByTime(160);

    // Disparar outro sample para confirmar
    mockAnalyser.getByteTimeDomainData.mockImplementationOnce((arr: Uint8Array) => {
      arr.fill(200);
    });
    vi.advanceTimersByTime(100);

    expect(detector.isSpeaking).toBe(true);
    expect(detectedSpeaking).toBe(true);
  });

  it('deve parar a detecção e fechar o AudioContext', () => {
    detector.start(mockStream);
    detector.stop();

    expect(mockAudioContext.close).toHaveBeenCalled();
    expect(detector.isSpeaking).toBe(false);
  });
});
