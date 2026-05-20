/**
 * Web Audio-based voice-activity detector. Emits a boolean `change` event when
 * the local mic transitions across the threshold.
 */
import { TypedEmitter } from './typedEmitter';

export interface SpeakingDetectorEvents extends Record<string, unknown> {
  change: boolean;
}

export interface SpeakingDetectorOptions {
  /** RMS threshold (0–1). Default: 0.04. */
  threshold?: number;
  /** Polling interval in ms. Default: 100. */
  intervalMs?: number;
  /** How long the value must stay above/below before emitting. Default: 150ms. */
  debounceMs?: number;
}

export class SpeakingDetector extends TypedEmitter<SpeakingDetectorEvents> {
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBoolean = false;
  private lastTransition = 0;
  private readonly threshold: number;
  private readonly intervalMs: number;
  private readonly debounceMs: number;

  constructor(options: SpeakingDetectorOptions = {}) {
    super();
    this.threshold = options.threshold ?? 0.04;
    this.intervalMs = options.intervalMs ?? 100;
    this.debounceMs = options.debounceMs ?? 150;
  }

  get isSpeaking(): boolean {
    return this.lastBoolean;
  }

  start(stream: MediaStream): void {
    this.stop();
    const Ctor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : ((window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext as typeof AudioContext | undefined);
    if (!Ctor) return;

    this.audioCtx = new Ctor();
    this.source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.dataArray = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
      void this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.analyser = null;
    this.audioCtx = null;
    this.dataArray = null;
    if (this.lastBoolean) {
      this.lastBoolean = false;
      this.emit('change', false);
    }
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private sample(): void {
    if (!this.analyser || !this.dataArray) return;
    this.analyser.getByteTimeDomainData(this.dataArray);
    let sumSquares = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const v = ((this.dataArray[i] ?? 128) - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / this.dataArray.length);
    const now = Date.now();
    const isLoud = rms > this.threshold;

    if (isLoud !== this.lastBoolean) {
      if (now - this.lastTransition >= this.debounceMs) {
        this.lastBoolean = isLoud;
        this.lastTransition = now;
        this.emit('change', isLoud);
      }
    } else {
      this.lastTransition = now;
    }
  }
}
