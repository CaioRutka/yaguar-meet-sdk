import { describe, it, expect, vi } from 'vitest';
import { createPeerConnection } from '../src/client/webrtc';

describe('webrtc - createPeerConnection', () => {
  it('deve instanciar um RTCPeerConnection com servidores customizados', () => {
    const mockConstructor = vi.fn();
    globalThis.RTCPeerConnection = class {
      constructor(opts: any) {
        mockConstructor(opts);
      }
    } as any;

    createPeerConnection([{ urls: 'stun:stun.l.google.com:19302' }]);

    expect(mockConstructor).toHaveBeenCalledWith({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
  });

  it('deve usar servidores padrão caso nenhum seja fornecido', () => {
    const mockConstructor = vi.fn();
    globalThis.RTCPeerConnection = class {
      constructor(opts: any) {
        mockConstructor(opts);
      }
    } as any;

    createPeerConnection([]);

    expect(mockConstructor).toHaveBeenCalledWith({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
  });
});
