import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { FileState, GoogleAIFileManager } from '@google/generative-ai/server';
import type { AIService, MeetingAnalysisResult, TranscribedUtterance } from './AIService';

const FILE_ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_POLL_MIN_MS = 500;
const FILE_POLL_MAX_MS = 2000;

const segmentedTranscriptSchema = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      start: { type: SchemaType.STRING },
      text: { type: SchemaType.STRING },
    },
    required: ['start', 'text'],
  },
};

const DEFAULT_SEGMENTED_PROMPT =
  'Transcreva o áudio em português. Este áudio contém a fala de UMA única pessoa. ' +
  'Para cada frase ou trecho de fala, retorne um objeto com "start" (o tempo de início ' +
  'no formato MM:SS ou HH:MM:SS, relativo ao começo do áudio) e "text" (o texto transcrito). ' +
  'Não inclua comentários, rótulos de locutor ou qualquer texto fora do JSON.';

/**
 * Parses a Gemini timestamp string ("12", "1:05", "01:02:03") into milliseconds.
 * Returns 0 for unparseable values so the utterance is still ordered sensibly.
 */
export function parseTimestampToMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw * 1000));
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(':').map((p) => Number(p.replace(',', '.')));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return Math.max(0, Math.round(seconds * 1000));
}

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
  /** Prompt used to transcribe the meeting audio (plain, single-string output). */
  transcribePrompt: string;
  /**
   * Optional prompt for timestamped/segmented transcription of a single
   * speaker's audio. Defaults to a Portuguese prompt that returns JSON.
   */
  transcribeSegmentsPrompt?: string;
  /**
   * Builds the analysis prompt for a transcript + rubric. The SDK ships no
   * default — consumers control the evaluation language and instructions.
   */
  buildAnalysisPrompt: (transcript: string, parameters: string[]) => string;
}

export class GeminiService implements AIService {
  private readonly plainModel;
  private readonly analysisModel;
  private readonly segmentedModel;
  private readonly fileManager: GoogleAIFileManager;
  private readonly transcribePrompt: string;
  private readonly transcribeSegmentsPrompt: string;
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
    this.segmentedModel = genAI.getGenerativeModel({
      model: modelId,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: segmentedTranscriptSchema,
      },
    });
    this.fileManager = new GoogleAIFileManager(opts.apiKey);
    this.transcribePrompt = opts.transcribePrompt;
    this.transcribeSegmentsPrompt = opts.transcribeSegmentsPrompt ?? DEFAULT_SEGMENTED_PROMPT;
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

  async transcribeAudioFileSegmented(
    filePath: string,
    mimeType: string
  ): Promise<TranscribedUtterance[]> {
    const mt = mimeType?.trim() || 'audio/webm';
    let remoteName: string | null = null;
    try {
      const upload = await this.fileManager.uploadFile(filePath, { mimeType: mt });
      remoteName = upload.file.name;
      const uri = await this.waitForFileActive(remoteName);

      const result = await this.segmentedModel.generateContent([
        { fileData: { fileUri: uri, mimeType: mt } },
        { text: this.transcribeSegmentsPrompt },
      ]);

      const raw = result.response.text();
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];

      return parsed
        .map((item) => {
          const obj = item as { start?: unknown; text?: unknown };
          return {
            offsetMs: parseTimestampToMs(obj.start),
            text: typeof obj.text === 'string' ? obj.text.trim() : '',
          };
        })
        .filter((u) => u.text.length > 0);
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

  async analyzeDocument(docName: string, docContent: string): Promise<string> {
    const prompt = `Você é um engenheiro de prompts e especialista em capacitação de vendas.
Analise o documento de vendas fornecido abaixo (Nome do arquivo: "${docName}").
Crie um conjunto claro, direto e estruturado de instruções e diretrizes (pre-prompt) que descrevem exatamente como o vendedor deve se comportar, quais regras do produto seguir, quais gatilhos mentais usar e quais objeções contornar com base neste documento.
O resultado final gerado deve ser redigido em português e será anexado diretamente ao prompt de avaliação de uma inteligência artificial para julgar a transcrição de chamadas desse vendedor.
Evite introduções e explicações genéricas. Vá direto ao ponto, fornecendo as regras estruturadas em tópicos claros.

Conteúdo do Documento:
---
${docContent}
---`;

    const result = await this.plainModel.generateContent(prompt);
    return result.response.text().trim();
  }
}

