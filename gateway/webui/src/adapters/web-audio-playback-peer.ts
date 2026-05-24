import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "audio-playback-peer"]);

export interface AudioLoopbackPeer {
  readonly audioElement: HTMLAudioElement | null;
  setup(destinationNode: MediaStreamAudioDestinationNode): Promise<void>;
  replaceTrack(destinationNode: MediaStreamAudioDestinationNode): void;
  reattachAudio(): void;
  destroy(): void;
}

/**
 * WebRTC loopback peer-connection lifecycle.
 *
 * Manages the two local RTCPeerConnections and the <audio> element that route
 * AudioContext output through the browser's AEC as "remote audio". Extracted
 * from web-audio-playback so the main adapter file stays under 300 lines.
 */
export function createAudioLoopbackPeer(): AudioLoopbackPeer {
  let localPeer: RTCPeerConnection | null = null;
  let remotePeer: RTCPeerConnection | null = null;
  let audioElement: HTMLAudioElement | null = null;
  let sender: RTCRtpSender | null = null;

  async function setup(destinationNode: MediaStreamAudioDestinationNode): Promise<void> {
    localPeer = new RTCPeerConnection();
    remotePeer = new RTCPeerConnection();

    // Wire ICE candidates between the two local peers
    localPeer.onicecandidate = (e) => {
      if (e.candidate) remotePeer?.addIceCandidate(e.candidate);
    };
    remotePeer.onicecandidate = (e) => {
      if (e.candidate) localPeer?.addIceCandidate(e.candidate);
    };

    // When the remote peer receives the audio track, play it through <audio>
    remotePeer.ontrack = (e) => {
      if (!audioElement) {
        audioElement = document.createElement("audio");
        audioElement.autoplay = true;
      }
      audioElement.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };

    // Add the destination node's track to the local peer
    const track = destinationNode.stream.getAudioTracks()[0];
    if (!track) return;
    sender = localPeer.addTrack(track, destinationNode.stream);

    // SDP exchange — connect the two peers
    const offer = await localPeer.createOffer();
    await localPeer.setLocalDescription(offer);
    await remotePeer.setRemoteDescription(offer);

    const answer = await remotePeer.createAnswer();
    await remotePeer.setLocalDescription(answer);
    await localPeer.setRemoteDescription(answer);

    log.debug("setup: peer connections established");
  }

  function replaceTrack(destinationNode: MediaStreamAudioDestinationNode): void {
    if (!sender || !localPeer) return;
    const newTrack = destinationNode.stream.getAudioTracks()[0];
    if (newTrack) {
      sender.replaceTrack(newTrack).catch(() => {});
    }
  }

  function reattachAudio(): void {
    if (!audioElement || !remotePeer) return;
    const receivers = remotePeer.getReceivers();
    const audioReceiver = receivers.find((r) => r.track?.kind === "audio");
    if (audioReceiver?.track) {
      audioElement.srcObject = new MediaStream([audioReceiver.track]);
      audioElement.play().catch(() => {});
    }
  }

  function destroy(): void {
    localPeer?.close();
    remotePeer?.close();
    if (audioElement) {
      audioElement.srcObject = null;
      audioElement.remove();
    }
    localPeer = null;
    remotePeer = null;
    audioElement = null;
    sender = null;
    log.debug("destroy: peer connections closed");
  }

  return {
    get audioElement() {
      return audioElement;
    },
    setup,
    replaceTrack,
    reattachAudio,
    destroy,
  };
}
