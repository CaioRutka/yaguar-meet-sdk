import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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

describe('RecordingSessionManager', () => {
  it('start creates a session and stop returns its path with the chunks written', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('meeting-1', 'audio/webm');
    expect(mgr.hasSession('meeting-1')).toBe(true);
    mgr.appendChunk('meeting-1', Buffer.from('hello-'));
    mgr.appendChunk('meeting-1', Buffer.from('world'));

    const result = await mgr.stop('meeting-1');
    expect(result).not.toBeNull();
    if (!result) throw new Error('stop returned null');
    expect(result.mimeType).toBe('audio/webm');
    const data = await readFile(result.filePath, 'utf8');
    expect(data).toBe('hello-world');
    expect(mgr.hasSession('meeting-1')).toBe(false);
  });

  it('stop returns null for an unknown key', async () => {
    const mgr = new RecordingSessionManager(workDir);
    expect(await mgr.stop('does-not-exist')).toBeNull();
  });

  it('stop deletes empty files and returns null', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('empty-meeting', 'audio/webm');
    const result = await mgr.stop('empty-meeting');
    expect(result).toBeNull();
    const filesAfter = await readdir(workDir);
    expect(filesAfter).toHaveLength(0);
  });

  it('appendChunk on unknown key is a no-op (no throw)', async () => {
    const mgr = new RecordingSessionManager(workDir);
    expect(() => mgr.appendChunk('ghost', Buffer.from('x'))).not.toThrow();
  });

  it('starting twice for same key discards the previous session', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('m1', 'audio/webm');
    mgr.appendChunk('m1', Buffer.from('first'));
    await mgr.start('m1', 'audio/webm');
    mgr.appendChunk('m1', Buffer.from('second'));
    const result = await mgr.stop('m1');
    expect(result).not.toBeNull();
    if (!result) return;
    const data = await readFile(result.filePath, 'utf8');
    expect(data).toBe('second');
    const stillThere = await stat(result.filePath).catch(() => null);
    expect(stillThere).not.toBeNull();
  });

  it('defaults the mime type to audio/webm when empty', async () => {
    const mgr = new RecordingSessionManager(workDir);
    await mgr.start('m1', '   ');
    mgr.appendChunk('m1', Buffer.from('x'));
    const result = await mgr.stop('m1');
    expect(result?.mimeType).toBe('audio/webm');
  });
});
