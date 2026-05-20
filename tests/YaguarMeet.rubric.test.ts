import { describe, it, expect } from 'vitest';
import { YaguarMeet } from '../src/server/YaguarMeet';
import type { AIService, MeetingAnalysisResult } from '../src/server/ai/AIService';
import { MemoryAdapter } from './_fixtures/MemoryAdapter';

const mockAIService: AIService = {
  async transcribeAudioFile() {
    return '';
  },
  async analyzeMeeting(): Promise<MeetingAnalysisResult> {
    return {
      overallScore: 0,
      summary: '',
      strengths: [],
      improvements: [],
      feedback: '',
      parameterScores: {},
    };
  },
};

type ResolveFn = (roomId: string, meetingId: string) => Promise<string[]>;
function getResolver(meet: YaguarMeet): ResolveFn {
  return (meet as unknown as { resolveAndSnapshotParameters: ResolveFn })
    .resolveAndSnapshotParameters.bind(meet);
}

async function seedMeeting(adapter: MemoryAdapter, hostUserId: string | null) {
  const room = await adapter.createRoom({ createdBy: hostUserId ?? undefined });
  const meeting = await adapter.saveMeeting({ roomId: room.id, status: 'active' });
  if (hostUserId) {
    await adapter.addMeetingAttendee(meeting.id, {
      userId: hostUserId,
      displayName: 'Host',
      isHost: true,
      joinedAt: new Date().toISOString(),
    });
  }
  return { roomId: room.id, meetingId: meeting.id };
}

describe('YaguarMeet.resolveAndSnapshotParameters', () => {
  it('uses cached snapshot when meeting.metadata.aiParameters exists', async () => {
    const adapter = new MemoryAdapter();
    const meet = new YaguarMeet({
      adapter,
      ai: { service: mockAIService, parameters: ['will-not-be-used'] },
    });
    const { roomId, meetingId } = await seedMeeting(adapter, 'host-1');
    await adapter.updateMeeting(meetingId, {
      metadata: { aiParameters: ['cached-A', 'cached-B'] },
    });

    const result = await getResolver(meet)(roomId, meetingId);
    expect(result).toEqual(['cached-A', 'cached-B']);
  });

  it('calls resolver with hostUserId derived from attendees and snapshots result', async () => {
    const adapter = new MemoryAdapter();
    let receivedCtx: { roomId: string; meetingId: string; hostUserId: string | null } | null = null;
    const meet = new YaguarMeet({
      adapter,
      ai: {
        service: mockAIService,
        parameters: async (ctx) => {
          receivedCtx = ctx;
          return ['from-resolver-1', 'from-resolver-2'];
        },
      },
    });
    const { roomId, meetingId } = await seedMeeting(adapter, 'host-1');

    const result = await getResolver(meet)(roomId, meetingId);
    expect(result).toEqual(['from-resolver-1', 'from-resolver-2']);
    expect(receivedCtx).toEqual({ roomId, meetingId, hostUserId: 'host-1' });

    const meetingAfter = await adapter.getMeeting(meetingId);
    expect(meetingAfter?.metadata?.aiParameters).toEqual(['from-resolver-1', 'from-resolver-2']);
  });

  it('resolver receives hostUserId=null when no attendee is host', async () => {
    const adapter = new MemoryAdapter();
    let receivedHost: string | null | undefined;
    const meet = new YaguarMeet({
      adapter,
      ai: {
        service: mockAIService,
        parameters: async (ctx) => {
          receivedHost = ctx.hostUserId;
          return ['fallback'];
        },
      },
    });
    const { roomId, meetingId } = await seedMeeting(adapter, null);

    await getResolver(meet)(roomId, meetingId);
    expect(receivedHost).toBeNull();
  });

  it('uses static array parameters and snapshots them', async () => {
    const adapter = new MemoryAdapter();
    const meet = new YaguarMeet({
      adapter,
      ai: { service: mockAIService, parameters: ['static-A', 'static-B'] },
    });
    const { roomId, meetingId } = await seedMeeting(adapter, 'host-1');

    const result = await getResolver(meet)(roomId, meetingId);
    expect(result).toEqual(['static-A', 'static-B']);
    const meetingAfter = await adapter.getMeeting(meetingId);
    expect(meetingAfter?.metadata?.aiParameters).toEqual(['static-A', 'static-B']);
  });

  it('returns empty array (no snapshot) when resolver throws', async () => {
    const adapter = new MemoryAdapter();
    const meet = new YaguarMeet({
      adapter,
      ai: {
        service: mockAIService,
        parameters: async () => {
          throw new Error('store down');
        },
      },
    });
    const { roomId, meetingId } = await seedMeeting(adapter, 'host-1');

    const result = await getResolver(meet)(roomId, meetingId);
    expect(result).toEqual([]);
    const meetingAfter = await adapter.getMeeting(meetingId);
    expect(meetingAfter?.metadata).toBeNull();
  });

  it('returns empty array when no AI is configured', async () => {
    const adapter = new MemoryAdapter();
    const meet = new YaguarMeet({ adapter });
    const { roomId, meetingId } = await seedMeeting(adapter, 'host-1');

    const result = await getResolver(meet)(roomId, meetingId);
    expect(result).toEqual([]);
  });
});
