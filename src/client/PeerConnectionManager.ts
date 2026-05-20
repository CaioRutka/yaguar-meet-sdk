/**
 * Manages one `RTCPeerConnection` per remote peer.
 *
 * - Creates a peer connection on demand and adds local audio + (camera|screen) tracks.
 * - Handles SDP offer/answer rollback for collisions.
 * - Replaces video tracks live when toggling between camera and screen share.
 * - Forwards remote tracks via `remote-stream` events.
 */
import type { IceServerConfig } from '../shared/types';
import { TypedEmitter } from './typedEmitter';
import { createPeerConnection } from './webrtc';
import type { SignalingClient } from './SignalingClient';

export interface PeerConnectionManagerEvents extends Record<string, unknown> {
  'remote-stream': { socketId: string; stream: MediaStream };
  'remote-stream-removed': { socketId: string };
  error: { socketId: string; error: unknown };
}

function pickVideoTrack(
  localStream: MediaStream | null,
  screenStream: MediaStream | null
): MediaStreamTrack | null {
  if (screenStream) {
    const t = screenStream.getVideoTracks()[0];
    if (t && t.readyState === 'live') return t;
  }
  if (localStream) {
    const t = localStream.getVideoTracks()[0];
    if (t) return t;
  }
  return null;
}

function pickAudioTrack(localStream: MediaStream | null): MediaStreamTrack | null {
  if (!localStream) return null;
  return localStream.getAudioTracks()[0] ?? null;
}

export class PeerConnectionManager extends TypedEmitter<PeerConnectionManagerEvents> {
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly negotiating = new Set<string>();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private iceServers: IceServerConfig[];
  private offDisposers: (() => void)[] = [];

  constructor(
    private readonly signaling: SignalingClient,
    options: { iceServers?: IceServerConfig[] } = {}
  ) {
    super();
    this.iceServers = options.iceServers ?? [];
    this.wireSignaling();
  }

  setIceServers(servers: IceServerConfig[]): void {
    this.iceServers = servers;
  }

  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    this.refreshSenders();
  }

  setScreenStream(stream: MediaStream | null): void {
    this.screenStream = stream;
    this.refreshSenders();
  }

  async dial(socketId: string): Promise<void> {
    this.ensurePeer(socketId);
    await this.sendOffer(socketId);
  }

  closePeer(socketId: string): void {
    const pc = this.peers.get(socketId);
    if (!pc) return;
    pc.close();
    this.peers.delete(socketId);
    this.negotiating.delete(socketId);
    this.emit('remote-stream-removed', { socketId });
  }

  dispose(): void {
    for (const dispose of this.offDisposers) dispose();
    this.offDisposers = [];
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.negotiating.clear();
    this.removeAllListeners();
  }

  private wireSignaling(): void {
    this.offDisposers.push(
      this.signaling.on('offer', async ({ from, signal }) => {
        const pc = this.ensurePeer(from);
        try {
          if (pc.signalingState !== 'stable') {
            await Promise.all([
              pc.setLocalDescription({ type: 'rollback' }),
              pc.setRemoteDescription(new RTCSessionDescription(signal as RTCSessionDescriptionInit)),
            ]);
          } else {
            await pc.setRemoteDescription(new RTCSessionDescription(signal as RTCSessionDescriptionInit));
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signaling.sendAnswer(from, answer);
        } catch (error) {
          this.emit('error', { socketId: from, error });
        }
      }),
      this.signaling.on('answer', async ({ from, signal }) => {
        const pc = this.peers.get(from);
        if (!pc) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(signal as RTCSessionDescriptionInit));
        } catch (error) {
          this.emit('error', { socketId: from, error });
        }
      }),
      this.signaling.on('ice-candidate', async ({ from, signal }) => {
        const pc = this.peers.get(from);
        if (!pc) return;
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signal as RTCIceCandidateInit));
        } catch (error) {
          this.emit('error', { socketId: from, error });
        }
      }),
      this.signaling.on('peer-left', ({ socketId }) => {
        this.closePeer(socketId);
      })
    );
  }

  private ensurePeer(socketId: string): RTCPeerConnection {
    let pc = this.peers.get(socketId);
    if (pc) return pc;

    pc = createPeerConnection(this.iceServers);
    this.peers.set(socketId, pc);

    const inboundStream = new MediaStream();

    pc.onicecandidate = (event) => {
      if (event.candidate) this.signaling.sendIceCandidate(socketId, event.candidate);
    };

    pc.ontrack = (event) => {
      const track = event.track;
      const existing = inboundStream.getTracks().find((t) => t.kind === track.kind && t.id !== track.id);
      if (existing) inboundStream.removeTrack(existing);
      if (!inboundStream.getTracks().some((t) => t.id === track.id)) inboundStream.addTrack(track);
      this.emit('remote-stream', { socketId, stream: inboundStream });
    };

    pc.onnegotiationneeded = () => {
      void this.sendOffer(socketId).catch((err) => this.emit('error', { socketId, error: err }));
    };

    const audio = pickAudioTrack(this.localStream);
    const video = pickVideoTrack(this.localStream, this.screenStream);
    if (audio && this.localStream) pc.addTrack(audio, this.localStream);
    if (video) pc.addTrack(video, this.screenStream ?? this.localStream ?? new MediaStream([video]));

    return pc;
  }

  private async sendOffer(socketId: string): Promise<void> {
    const pc = this.peers.get(socketId);
    if (!pc) return;
    if (this.negotiating.has(socketId)) return;
    this.negotiating.add(socketId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendOffer(socketId, offer);
    } finally {
      this.negotiating.delete(socketId);
    }
  }

  private refreshSenders(): void {
    const audio = pickAudioTrack(this.localStream);
    const video = pickVideoTrack(this.localStream, this.screenStream);

    for (const pc of this.peers.values()) {
      const senders = pc.getSenders();

      const videoSender = senders.find((s) => s.track === null || s.track?.kind === 'video');
      if (videoSender) {
        void videoSender.replaceTrack(video);
      } else if (video) {
        pc.addTrack(video, this.screenStream ?? this.localStream ?? new MediaStream([video]));
      }

      const audioSender = senders.find((s) => s.track?.kind === 'audio');
      if (audioSender && audio && audioSender.track?.id !== audio.id) {
        void audioSender.replaceTrack(audio);
      }
    }
  }
}
