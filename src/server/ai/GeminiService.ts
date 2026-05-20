import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { FileState, GoogleAIFileManager } from '@google/generative-ai/server';
import type { AIService, MeetingAnalysisResult } from './AIService';

const FILE_ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_POLL_MIN_MS = 500;
const FILE_POLL_MAX_MS = 2000;

const analysisResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    overallScore: { type: SchemaType.NUMBER },
    summary: { type: SchemaType.STRING },
    strengths: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    improvements: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    feedback: { type: SchemaType.STRING },
    parameterScores: { type: SchemaType.OBJECT },
  },
  required: ['overallScore', 'summary', 'strengths', 'improvements', 'feedback', 'parameterScores'],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GeminiServiceOptions {
  apiKey: string;
  /** Gemini model id. Default: `gemini-2.5-flash`. */
  model?: string;
  /** Prompt used to transcribe the meeting audio. */
  transcribePrompt: string;
  /**
   * Builds the analysis prompt for a transcript + rubric. The SDK ships no
   * default — consumers control the evaluation language and instructions.
   */
  buildAnalysisPrompt: (transcript: string, parameters: string[]) => string;
}

export class GeminiService implements AIService {
  private readonly plainModel;
  private readonly analysisModel;
  private readonly fileManager: GoogleAIFileManager;
  private readonly transcribePrompt: string;
  private readonly buildAnalysisPrompt: (transcript: string, parameters: string[]) => string;

  constructor(opts: GeminiServiceOptions) {
    const modelId = opts.model ?? 'gemini-2.5-flash';
    const genAI = new GoogleGenerativeAI(opts.apiKey);
    this.plainModel = genAI.getGenerativeModel({ model: modelId });
    this.analysisModel = genAI.getGenerativeModel({
      model: modelId,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: analysisResponseSchema,
      },
    });
    this.fileManager = new GoogleAIFileManager(opts.apiKey);
    this.transcribePrompt = opts.transcribePrompt;
    this.buildAnalysisPrompt = opts.buildAnalysisPrompt;
  }

  private async waitForFileActive(fileName: string): Promise<string> {
    const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;
    let delay = FILE_POLL_MIN_MS;
    while (Date.now() < deadline) {
      const meta = await this.fileManager.getFile(fileName);
      if (meta.state === FileState.ACTIVE) {
        return meta.uri;
      }
      if (meta.state === FileState.FAILED) {
        const msg = meta.error?.message || 'File processing failed';
        throw new Error(msg);
      }
      await sleep(delay);
      delay = Math.min(Math.floor(delay * 1.5), FILE_POLL_MAX_MS);
    }
    throw new Error('Timeout waiting for uploaded file to become ACTIVE');
  }

  async transcribeAudioFile(filePath: string, mimeType: string): Promise<string> {
    const mt = mimeType?.trim() || 'audio/webm';
    let remoteName: string | null = null;
    try {
      const upload = await this.fileManager.uploadFile(filePath, { mimeType: mt });
      remoteName = upload.file.name;
      const uri = await this.waitForFileActive(remoteName);

      const result = await this.plainModel.generateContent([
        {
          fileData: {
            fileUri: uri,
            mimeType: mt,
          },
        },
        { text: this.transcribePrompt },
      ]);
      return result.response.text().trim();
    } finally {
      if (remoteName) {
        await this.fileManager.deleteFile(remoteName).catch(() => {});
      }
    }
  }

  async analyzeMeeting(transcript: string, parameters: string[]): Promise<MeetingAnalysisResult> {
    const prompt = this.buildAnalysisPrompt(transcript, parameters);
    const result = await this.analysisModel.generateContent(prompt);
    const raw = result.response.text();
    const parsed = JSON.parse(raw) as MeetingAnalysisResult;
    return {
      overallScore: Number(parsed.overallScore) || 0,
      summary: String(parsed.summary ?? ''),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.map(String) : [],
      feedback: String(parsed.feedback ?? ''),
      parameterScores:
        parsed.parameterScores && typeof parsed.parameterScores === 'object'
          ? parsed.parameterScores
          : {},
    };
  }
}
