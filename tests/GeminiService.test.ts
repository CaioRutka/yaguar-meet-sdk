import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiService } from '../src/server/ai/GeminiService';

const mockGenerateContent = vi.fn();
const mockUploadFile = vi.fn();
const mockGetFile = vi.fn();
const mockDeleteFile = vi.fn();

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: vi.fn().mockImplementation(() => ({
        generateContent: mockGenerateContent,
      })),
    })),
    SchemaType: {
      OBJECT: 'OBJECT',
      NUMBER: 'NUMBER',
      STRING: 'STRING',
      ARRAY: 'ARRAY',
    },
  };
});

vi.mock('@google/generative-ai/server', () => {
  return {
    GoogleAIFileManager: vi.fn().mockImplementation(() => ({
      uploadFile: mockUploadFile,
      getFile: mockGetFile,
      deleteFile: mockDeleteFile,
    })),
    FileState: {
      ACTIVE: 'ACTIVE',
      FAILED: 'FAILED',
      PROCESSING: 'PROCESSING',
    },
  };
});

describe('GeminiService', () => {
  let service: GeminiService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GeminiService({
      apiKey: 'test-api-key',
      model: 'gemini-2.5-flash',
      transcribePrompt: 'Transcreva em português.',
      buildAnalysisPrompt: (transcript, parameters) =>
        `Analise: ${transcript}. Rúbricas: ${parameters.join(', ')}`,
    });
  });

  it('deve instanciar o serviço com o modelo correto', () => {
    expect(service).toBeDefined();
  });

  it('deve analisar uma reunião com sucesso', async () => {
    const mockResponseText = JSON.stringify({
      overallScore: 85,
      summary: 'Conversa produtiva',
      strengths: ['Cordialidade'],
      improvements: ['Fechamento objetivo'],
      feedback: 'Muito bom trabalho.',
      parameterScores: { 'Cordialidade': 5 },
    });

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => mockResponseText,
      },
    });

    const result = await service.analyzeMeeting('Olá, tudo bem? Sim, tudo.', ['Cordialidade']);

    expect(result.overallScore).toBe(85);
    expect(result.summary).toBe('Conversa produtiva');
    expect(result.strengths).toEqual(['Cordialidade']);
    expect(result.improvements).toEqual(['Fechamento objetivo']);
    expect(result.feedback).toBe('Muito bom trabalho.');
    expect(result.parameterScores).toEqual({ 'Cordialidade': 5 });
  });

  it('deve analisar um documento com sucesso', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => ' Diretrizes do documento. ',
      },
    });

    const result = await service.analyzeDocument('manual.txt', 'Preços a partir de R$ 100.');

    expect(result).toBe('Diretrizes do documento.');
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  it('deve transcrever um arquivo de áudio com sucesso', async () => {
    mockUploadFile.mockResolvedValueOnce({
      file: { name: 'files/audio-uuid-123' },
    });

    mockGetFile.mockResolvedValueOnce({
      state: 'ACTIVE',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/audio-uuid-123',
    });

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => ' Transcrição final. ',
      },
    });

    mockDeleteFile.mockResolvedValueOnce({});

    const transcript = await service.transcribeAudioFile('path/to/audio.webm', 'audio/webm');

    expect(transcript).toBe('Transcrição final.');
    expect(mockUploadFile).toHaveBeenCalledWith('path/to/audio.webm', { mimeType: 'audio/webm' });
    expect(mockGetFile).toHaveBeenCalledWith('files/audio-uuid-123');
    expect(mockDeleteFile).toHaveBeenCalledWith('files/audio-uuid-123');
  });

  it('deve lançar erro se o processamento do arquivo falhar', async () => {
    mockUploadFile.mockResolvedValueOnce({
      file: { name: 'files/audio-uuid-123' },
    });

    mockGetFile.mockResolvedValueOnce({
      state: 'FAILED',
      error: { message: 'Formato de áudio corrompido' },
    });

    mockDeleteFile.mockResolvedValueOnce({});

    await expect(service.transcribeAudioFile('path/to/audio.webm', 'audio/webm')).rejects.toThrow(
      'Formato de áudio corrompido'
    );

    expect(mockDeleteFile).toHaveBeenCalledWith('files/audio-uuid-123');
  });
});
