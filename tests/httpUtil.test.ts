import { describe, it, expect } from 'vitest';
import {
  parsePath,
  parseQuery,
  pathUnderPrefix,
  segments,
  serializeErrorForHttp,
} from '../src/server/http/httpUtil';

describe('parsePath', () => {
  it('returns / for undefined url', () => {
    expect(parsePath(undefined)).toBe('/');
  });

  it('strips query string', () => {
    expect(parsePath('/api/rooms?foo=bar')).toBe('/api/rooms');
  });

  it('returns the path untouched when no query', () => {
    expect(parsePath('/api/rooms')).toBe('/api/rooms');
  });
});

describe('parseQuery', () => {
  it('returns empty object for no query', () => {
    expect(parseQuery('/api/rooms')).toEqual({});
  });

  it('parses key/value pairs', () => {
    expect(parseQuery('/api?userId=42&page=2')).toEqual({ userId: '42', page: '2' });
  });

  it('handles url-encoded values', () => {
    expect(parseQuery('/api?name=Caio%20Ferreira')).toEqual({ name: 'Caio Ferreira' });
  });
});

describe('pathUnderPrefix', () => {
  it('returns / when path equals prefix', () => {
    expect(pathUnderPrefix('/api', '/api')).toBe('/');
  });

  it('strips prefix and returns leading-slash subpath', () => {
    expect(pathUnderPrefix('/api/rooms/123', '/api')).toBe('/rooms/123');
  });

  it('returns null when prefix does not match', () => {
    expect(pathUnderPrefix('/other/rooms', '/api')).toBeNull();
  });

  it('handles trailing slash in prefix', () => {
    expect(pathUnderPrefix('/api/rooms', '/api/')).toBe('/rooms');
  });
});

describe('segments', () => {
  it('drops empty segments and leading slash', () => {
    expect(segments('/rooms/abc/meetings')).toEqual(['rooms', 'abc', 'meetings']);
  });

  it('returns empty array for root', () => {
    expect(segments('/')).toEqual([]);
  });
});

describe('serializeErrorForHttp', () => {
  it('serializes Error instances', () => {
    expect(serializeErrorForHttp(new Error('boom'))).toEqual({ error: 'boom' });
  });

  it('extracts message+code from PostgrestError-like objects', () => {
    const e = { message: 'duplicate key', code: '23505', details: 'rooms_pkey', hint: 'check id' };
    expect(serializeErrorForHttp(e)).toEqual({
      error: 'duplicate key',
      code: '23505',
      details: 'rooms_pkey',
      hint: 'check id',
    });
  });

  it('falls back to stringify for plain values', () => {
    expect(serializeErrorForHttp({ foo: 'bar' })).toEqual({ error: JSON.stringify({ foo: 'bar' }) });
  });
});
