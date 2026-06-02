import { EventEmitter } from 'events';
import { unlink } from 'node:fs/promises';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import type { AIService } from './ai/AIService';
import type { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import { handleMeetHttp } from './http/meetHttp';
import { RecordingSessionManager } from './RecordingSessionManager';
import { RoomManager } from './RoomManager';
import { registerSocketHandlers } from './registerSocketHandlers';
import type { IceServerConfig } from '../shared/types';
import type {
  MeetingEndContext,
  YaguarMeetConfig,
  YaguarMeetRoomConfig,
} from './types';

export interface YaguarMeetEvents {
  'analysis:ready': [payload: { meetingId: string; analysis: unknown }];
  'meeting:processing': [payload: { roomId: string; meetingId: string }];
}

const defaultIceServers: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export class YaguarMeet extends EventEmitter {
  private io: SocketIOServer | null = null;
  private readonly adapter: DatabaseAdapter;
  private readonly roomConfig: YaguarMeetRoomConfig;
  private readonly iceServers: IceServerConfig[];
  private readonly recording: RecordingSessionManager;
  private roomManager!: RoomManager;
  private ai: AIService | undefined;
  private readonly aiParameters:
    | string[]
    | ((ctx: { roomId: string; meetingId: string; hostUserId: string | null }) => Promise<string[]>)
    | undefined;

  constructor(private readonly config: YaguarMeetConfig) {
    super();
    this.adapter = config.adapter;
    this.roomConfig = {
      maxParticipants: config.room?.maxParticipants ?? 6,
      cleanupTimeoutMs: config.room?.cleanupTimeoutMs ?? 5 * 60 * 1000,
    };
    this.iceServers = config.iceServers?.length ? config.iceServers : defaultIceServers;
    this.recording = new RecordingSessionManager(config.recordingTmpDir);
    if (config.ai) {
      this.ai = config.ai.service;
      this.aiParameters = config.ai.parameters;
    } else {
      this.aiParameters = undefined;
    }

    this.roomManager = new RoomManager(this.adapter, this.roomConfig, (ctx) =>
      this.handleMeetingProcessing(ctx)
    );
  }

  get socketServer(): SocketIOServer | null {
    return this.io;
  }

  attach(httpServer: HttpServer): SocketIOServer {
    if (this.io) {
      return this.io;
    }
    const cors = this.config.cors ?? { origin: '*', methods: ['GET', 'POST'], credentials: true };
    this.io = new SocketIOServer(httpServer, {
      cors,
      transports: ['websocket', 'polling'],
    });

    if (this.config.auth?.socketAuth) {
      this.io.use(this.config.auth.socketAuth);
    }

    registerSocketHandlers(this.io, {
      roomManager: this.roomManager,
      adapter: this.adapter,
      iceServers: this.iceServers,
      recording: this.recording,
      hooks: this.config.hooks,
      requireRecording: this.config.requireRecording,
      onScheduleReturn: this.config.onScheduleReturn,
    });

    return this.io;
  }

  /**
   * Handle REST with Node's `IncomingMessage` / `ServerResponse` only (no Express).
   * Returns `true` if the request was under `prefix` and a response was sent (including 404).
   * Returns `false` if the path is outside the prefix — let your server / Socket.IO handle it.
   */
  async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    options?: { prefix?: string }
  ): Promise<boolean> {
    return handleMeetHttp(req, res, {
      roomManager: this.roomManager,
      adapter: this.adapter,
      maxParticipants: this.roomConfig.maxParticipants,
      prefix: options?.prefix ?? '/api',
      httpAuth: this.config.auth?.httpAuth,
    });
  }

  private async handleMeetingProcessing(ctx: { roomId: string; meetingId: string | null }): Promise<void> {
    if (!ctx.meetingId) return;
    this.emit('meeting:processing', { roomId: ctx.roomId, meetingId: ctx.meetingId });
    await this.processMeetingPipeline({ roomId: ctx.roomId, meetingId: ctx.meetingId });
  }

  /**
   * Resolve the rubric for this meeting and snapshot it on the meeting metadata.
   *
   * Order of precedence:
   *   1. Existing `meeting.metadata.aiParameters` (snapshot from a prior run).
   *   2. Resolver function from config (called with `hostUserId` derived from attendees).
   *   3. Static array from config.
   *   4. Empty array (no AI configured / no parameters).
   *
   * Snapshot ensures re-analyses reproduce the original scoring even if the
   * consumer's rubric changes later.
   */
  private async resolveAndSnapshotParameters(
    roomId: string,
    meetingId: string
  ): Promise<string[]> {
    const meeting = await this.adapter.getMeeting(meetingId);
    const existing = meeting?.metadata?.aiParameters;
    if (Array.isArray(existing) && existing.every((p) => typeof p === 'string')) {
      return existing as string[];
    }

    let parameters: string[] = [];
    if (typeof this.aiParameters === 'function') {
      const attendees = await this.adapter.getMeetingAttendees(meetingId);
      const host = attendees.find((a) => a.isHost) ?? null;
      try {
        parameters = await this.aiParameters({
          roomId,
          meetingId,
          hostUserId: host?.userId ?? null,
        });
      } catch (e) {
        console.error('[YaguarMeet] rubric resolver failed; falling back to empty list', e);
        parameters = [];
      }
    } else if (Array.isArray(this.aiParameters)) {
      parameters = this.aiParameters;
    }

    if (parameters.length > 0) {
      await this.mergeMeetingMetadata(meetingId, { aiParameters: parameters });
    }

    return parameters;
  }

  private async mergeMeetingMetadata(meetingId: string, patch: Record<string, unknown>): Promise<void> {
    const m = await this.adapter.getMeeting(meetingId);
    const prev =
      m?.metadata && typeof m.metadata === 'object' && !Array.isArray(m.metadata)
        ? { ...(m.metadata as Record<string, unknown>) }
        : {};
    await this.adapter.updateMeeting(meetingId, { metadata: { ...prev, ...patch } });
  }

  private async processMeetingPipeline(ctx: {
    roomId: string;
    meetingId: string;
  }): Promise<void> {
    const { roomId, meetingId } = ctx;

    if (this.io) {
      this.io.in(roomId).emit('meeting:ended', { roomId, meetingId });
    }

    let tempPaths: string[] = [];
    let stopped: { segments: { filePath: string; mimeType: string }[] } | null = null;
    try {
      stopped = await this.recording.stop(meetingId);
      if (stopped) tempPaths = stopped.segments.map((s) => s.filePath);

      let transcript = '';

      if (stopped && stopped.segments.length > 0 && this.ai) {
        try {
          const parts: string[] = [];
          for (const segment of stopped.segments) {
            const text = await this.ai.transcribeAudioFile(segment.filePath, segment.mimeType);
            if (text.trim()) parts.push(text.trim());
          }
          transcript = parts.join('\n\n');
        } catch (e) {
          console.error('[YaguarMeet] transcribeAudioFile', e);
          await this.mergeMeetingMetadata(meetingId, {
            transcribeError: String(e),
            analysisFallback:
              'Não foi possível transcrever o áudio. Tente gravar novamente em outra reunião ou verifique o microfone.',
          });
        }
      } else if (!stopped || stopped.segments.length === 0) {
        await this.mergeMeetingMetadata(meetingId, {
          analysisFallback:
            'Nenhum áudio foi recebido. Só o anfitrião pode iniciar a gravação para IA — ative-a durante a próxima reunião.',
        });
      }

      try {
        await this.adapter.updateMeeting(meetingId, {
          transcript: transcript.trim() ? transcript : null,
          status: 'processing',
        });
      } catch (e) {
        console.error('[YaguarMeet] updateMeeting transcript', e);
      }

      const hasText = Boolean(transcript.trim());

      if (this.ai && hasText) {
        try {
          const parameters = await this.resolveAndSnapshotParameters(roomId, meetingId);
          const analysis = await this.ai.analyzeMeeting(transcript, parameters);
          const saved = await this.adapter.saveAnalysis({
            meetingId,
            overallScore: analysis.overallScore,
            summary: analysis.summary,
            strengths: analysis.strengths,
            improvements: analysis.improvements,
            feedback: analysis.feedback,
            parameterScores: analysis.parameterScores,
          });
          this.emit('analysis:ready', { meetingId, analysis: saved });
        } catch (e) {
          console.error('[YaguarMeet] analyzeMeeting', e);
          await this.mergeMeetingMetadata(meetingId, {
            analysisError: String(e),
            analysisFallback:
              'A análise automática não pôde ser concluída. A transcrição bruta permanece disponível para o anfitrião no histórico.',
          });
        }
      } else if (this.ai && !hasText && stopped && stopped.segments.length > 0) {
        const m = await this.adapter.getMeeting(meetingId);
        const existing = m?.metadata && typeof m.metadata.analysisFallback === 'string';
        if (!existing) {
          await this.mergeMeetingMetadata(meetingId, {
            analysisFallback: 'Sem conteúdo transcrito para avaliar.',
          });
        }
      } else if (!this.ai) {
        await this.mergeMeetingMetadata(meetingId, {
          analysisFallback:
            'IA não configurada no servidor. Quando houver transcrição, o anfitrião pode consultá-la no painel de histórico.',
        });
      }

      await this.adapter.updateMeeting(meetingId, { status: 'completed' });

      const finalAnalysis = await this.adapter.getAnalysisByMeeting(meetingId);
      const meetingAfter = await this.adapter.getMeeting(meetingId);
      const analysisFallback =
        typeof meetingAfter?.metadata?.analysisFallback === 'string'
          ? meetingAfter.metadata.analysisFallback
          : null;

      if (this.io) {
        this.io.in(roomId).emit('meeting:complete', {
          roomId,
          meetingId,
          analysis: finalAnalysis,
          analysisFallback,
        });
      }

      const meeting = meetingAfter;
      if (meeting) {
        const endCtx: MeetingEndContext = { roomId, meetingId, meeting };
        try {
          await this.config.hooks?.onMeetingEnd?.(endCtx);
        } catch (e) {
          console.error('[YaguarMeet] onMeetingEnd', e);
        }
      }
    } finally {
      for (const p of tempPaths) {
        await unlink(p).catch(() => {});
      }
    }
  }
}
