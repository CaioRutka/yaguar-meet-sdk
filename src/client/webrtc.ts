/**
 * Factory for a fresh `RTCPeerConnection` using the supplied ICE servers.
 */
import type { IceServerConfig } from '../shared/types';

const DEFAULT_ICE: IceServerConfig[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createPeerConnection(iceServers?: IceServerConfig[]): RTCPeerConnection {
  const servers = iceServers && iceServers.length ? iceServers : DEFAULT_ICE;
  return new RTCPeerConnection({ iceServers: servers as RTCIceServer[] });
}
