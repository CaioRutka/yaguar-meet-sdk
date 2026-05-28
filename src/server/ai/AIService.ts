import type { MeetingAnalysisResult } from '../../shared/types';

export type { MeetingAnalysisResult };

/**
 * Provider-agnostic AI service contract used by `YaguarMeet`.
 *
 * Implementations: `GeminiService` (default), or any custom class implementing
 * this interface.
 */
export interface AIService {
  transcribeAudioFile(filePath: string, mimeType: string): Promise<string>;
  analyzeMeeting(transcript: string, parameters: string[]): Promise<MeetingAnalysisResult>;
  analyzeDocument(docName: string, docContent: string): Promise<string>;
}
