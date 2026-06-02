import type { MeetingAnalysisResult } from '../../shared/types';

export type { MeetingAnalysisResult };

/**
 * Provider-agnostic AI service contract used by `YaguarMeet`.
 *
 * Implementations: `GeminiService` (default), or any custom class implementing
 * this interface.
 */
/** A single timestamped utterance within one audio file. */
export interface TranscribedUtterance {
  /** Milliseconds from the start of this audio file. */
  offsetMs: number;
  /** Transcribed text for the utterance. */
  text: string;
}

export interface AIService {
  transcribeAudioFile(filePath: string, mimeType: string): Promise<string>;
  /**
   * Optional: transcribe an audio file into timestamped utterances. Used by the
   * per-participant recording pipeline to interleave speakers chronologically.
   * Implementations that don't support timestamps can omit this — the pipeline
   * falls back to {@link AIService.transcribeAudioFile}.
   */
  transcribeAudioFileSegmented?(filePath: string, mimeType: string): Promise<TranscribedUtterance[]>;
  analyzeMeeting(transcript: string, parameters: string[]): Promise<MeetingAnalysisResult>;
  analyzeDocument(docName: string, docContent: string): Promise<string>;
}
