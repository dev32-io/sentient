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
    const nextLocalPeer = new RTCPeerConnection();
    const nextRemotePeer = new RTCPeerConnection();
    localPeer = nextLocalPeer;
    remotePeer = nextRemotePeer;

    function assertCurrent(): void {
      if (localPeer === nextLocalPeer && remotePeer === nextRemotePeer) return;
      nextLocalPeer.close();
      nextRemotePeer.close();
      const error = new Error("AEC loopback setup was cancelled.");
      error.name = "AbortError";
      throw error;
    }

    // Wire ICE candidates between the two local peers. Each callback closes
    // over its own pair so a stale setup can never mutate a replacement pair.
    nextLocalPeer.onicecandidate = (e) => {
      if (e.candidate && remotePeer === nextRemotePeer) {
        void nextRemotePeer.addIceCandidate(e.candidate).catch(() => undefined);
      }
    };
    nextRemotePeer.onicecandidate = (e) => {
      if (e.candidate && localPeer === nextLocalPeer) {
        void nextLocalPeer.addIceCandidate(e.candidate).catch(() => undefined);
      }
    };

    // When the remote peer receives the audio track, play it through <audio>.
    nextRemotePeer.ontrack = (e) => {
      if (remotePeer !== nextRemotePeer) return;
      if (!audioElement) {
        audioElement = document.createElement("audio");
        audioElement.autoplay = true;
      }
      audioElement.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };

    // Add the destination node's track to the local peer.
    const track = destinationNode.stream.getAudioTracks()[0];
    if (!track) return;
    const nextSender = nextLocalPeer.addTrack(track, destinationNode.stream);

    // SDP exchange — connect the two peers. Check ownership after every
    // asynchronous boundary so destroy() is a real cancellation fence.
    const offer = await nextLocalPeer.createOffer();
    assertCurrent();
    await nextLocalPeer.setLocalDescription(offer);
    assertCurrent();
    await nextRemotePeer.setRemoteDescription(offer);
    assertCurrent();

    const answer = await nextRemotePeer.createAnswer();
    assertCurrent();
    await nextRemotePeer.setLocalDescription(answer);
    assertCurrent();
    await nextLocalPeer.setRemoteDescription(answer);
    assertCurrent();
    sender = nextSender;

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
