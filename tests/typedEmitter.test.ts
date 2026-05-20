import { describe, it, expect } from 'vitest';
import { TypedEmitter } from '../src/client/typedEmitter';

interface FooEvents extends Record<string, unknown> {
  hello: string;
  count: number;
}

describe('TypedEmitter', () => {
  it('emits values to subscribed listeners', () => {
    const e = new TypedEmitter<FooEvents>();
    const received: string[] = [];
    e.on('hello', (v) => received.push(v));
    e.emit('hello', 'world');
    e.emit('hello', 'again');
    expect(received).toEqual(['world', 'again']);
  });

  it('does not cross-pollute event channels', () => {
    const e = new TypedEmitter<FooEvents>();
    const received: number[] = [];
    e.on('count', (n) => received.push(n));
    e.emit('hello', 'ignored');
    e.emit('count', 42);
    expect(received).toEqual([42]);
  });

  it('off() removes listener', () => {
    const e = new TypedEmitter<FooEvents>();
    const received: string[] = [];
    const off = e.on('hello', (v) => received.push(v));
    e.emit('hello', 'first');
    off();
    e.emit('hello', 'second');
    expect(received).toEqual(['first']);
  });

  it('removeAllListeners clears every channel', () => {
    const e = new TypedEmitter<FooEvents>();
    let helloCount = 0;
    let countCount = 0;
    e.on('hello', () => helloCount++);
    e.on('count', () => countCount++);
    e.removeAllListeners();
    e.emit('hello', 'x');
    e.emit('count', 1);
    expect(helloCount).toBe(0);
    expect(countCount).toBe(0);
  });

  it('isolates a thrown listener from siblings', () => {
    const e = new TypedEmitter<FooEvents>();
    const received: string[] = [];
    e.on('hello', () => {
      throw new Error('boom');
    });
    e.on('hello', (v) => received.push(v));
    expect(() => e.emit('hello', 'ok')).not.toThrow();
    expect(received).toEqual(['ok']);
  });

  it('reports listenerCount', () => {
    const e = new TypedEmitter<FooEvents>();
    expect(e.listenerCount('hello')).toBe(0);
    e.on('hello', () => {});
    e.on('hello', () => {});
    expect(e.listenerCount('hello')).toBe(2);
  });
});
