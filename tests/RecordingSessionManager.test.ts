import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingSessionManager } from '../src/server/RecordingSessionManager';

let workDir = '';

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'yaguar-rec-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const caio = { participantKey: 'sock-caio', speaker: 'Caio', speakerId: 'user-caio', mimeType: 'audio/webm' };
const joao = { participantKey: 'sock-joao', speaker: 'João', speakerId: 'user-joao', mimeType: 'audio/webm' };

describe('RecordingSessionManager', () => {
  it('start creates a session and stop returns its path with the chunks written', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('meeting-1', caio);
    expect(mgr.hasSession('meeting-1')).toBe(true);
    mgr.appendChunk('meeting-1', caio.participantKey, Buffer.from('hello-'));
    mgr.appendChunk('meeting-1', caio.participantKey, Buffer.from('world'));

    const result = await mgr.stop('meeting-1');
    expect(result).not.toBeNull();
    if (!result) throw new Error('stop returned null');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.mimeType).toBe('audio/webm');
    expect(result.segments[0]?.speaker).toBe('Caio');
    expect(result.segments[0]?.speakerId).toBe('user-caio');
    expect(typeof result.segments[0]?.startedAt).toBe('number');
    const data = await readFile(result.segments[0]!.filePath, 'utf8');
    expect(data).toBe('hello-world');
    expect(mgr.hasSession('meeting-1')).toBe(false);
  });

  it('captures multiple participants and orders segments by start time', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('m1', caio);
    mgr.appendChunk('m1', caio.participantKey, Buffer.from('sou o caio'));
    // Ensure a distinct, later start time for João's stream.
    await new Promise((r) => setTimeout(r, 5));
    await mgr.start('m1', joao);
    mgr.appendChunk('m1', joao.participantKey, Buffer.from('sou o joao'));

    const result = await mgr.stop('m1');
    expect(result?.segments).toHaveLength(2);
    expect(result?.segments[0]?.speaker).toBe('Caio');
    expect(result?.segments[1]?.speaker).toBe('João');
    expect(result!.segments[0]!.startedAt).toBeLessThanOrEqual(result!.segments[1]!.startedAt);
  });

  it('stop returns null for an unknown key', async () => {
    const mgr = new RecordingSessionManager(workDir);
    expect(await mgr.stop('does-not-exist')).toBeNull();
  });

  it('stop deletes empty files and returns null', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('empty-meeting', caio);
    const result = await mgr.stop('empty-meeting');
    expect(result).toBeNull();
    const filesAfter = await readdir(workDir);
    expect(filesAfter).toHaveLength(0);
  });

  it('appendChunk on unknown key/participant is a no-op (no throw)', async () => {
    const mgr = new RecordingSessionManager(workDir);
    expect(() => mgr.appendChunk('ghost', 'nobody', Buffer.from('x'))).not.toThrow();
  });

  it('pause and resume create multiple segments for the same participant', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('m1', caio);
    mgr.appendChunk('m1', caio.participantKey, Buffer.from('first'));
    await mgr.pauseParticipant('m1', caio.participantKey);

    await mgr.start('m1', caio);
    mgr.appendChunk('m1', caio.participantKey, Buffer.from('second'));

    const result = await mgr.stop('m1');
    expect(result?.segments).toHaveLength(2);
    const first = await readFile(result!.segments[0]!.filePath, 'utf8');
    const second = await readFile(result!.segments[1]!.filePath, 'utf8');
    expect(first).toBe('first');
    expect(second).toBe('second');
  });

  it('starting again for same participant finalizes the previous active segment', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('m1', caio);
    mgr.appendChunk('m1', caio.participantKey, Buffer.from('first'));
    await mgr.start('m1', caio);
    mgr.appendChunk('m1', caio.participantKey, Buffer.from('second'));
    const result = await mgr.stop('m1');
    expect(result?.segments).toHaveLength(2);
  });

  it('defaults the mime type to audio/webm when empty', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('m1', { ...caio, mimeType: '   ' });
    mgr.appendChunk('m1', caio.participantKey, Buffer.from('x'));
    const result = await mgr.stop('m1');
    expect(result?.segments[0]?.mimeType).toBe('audio/webm');
  });
});
