import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioLoopbackPeer } from "./web-audio-playback-peer.ts";

function makePeer() {
  return {
    onicecandidate: null as ((event: RTCPeerConnectionIceEvent) => void) | null,
    ontrack: null as ((event: RTCTrackEvent) => void) | null,
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    addTrack: vi.fn().mockReturnValue({ replaceTrack: vi.fn().mockResolvedValue(undefined) }),
    createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "" }),
    createAnswer: vi.fn().mockResolvedValue({ type: "answer", sdp: "" }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    getReceivers: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio loopback ICE lifecycle", () => {
  it("handles candidate delivery rejection if teardown races ICE", async () => {
    const local = makePeer();
    const remote = makePeer();
    const peers = [local, remote];
    let peerIndex = 0;
    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(() => peers[peerIndex++]),
    );
    const destination = {
      stream: { getAudioTracks: vi.fn(() => [{ kind: "audio" }]) },
    } as unknown as MediaStreamAudioDestinationNode;
    const loopback = createAudioLoopbackPeer();
    await loopback.setup(destination);

    const localCandidateFailure = Promise.reject(new Error("peer closed"));
    const remoteCandidateFailure = Promise.reject(new Error("peer closed"));
    const localCatch = vi.spyOn(localCandidateFailure, "catch");
    const remoteCatch = vi.spyOn(remoteCandidateFailure, "catch");
    remote.addIceCandidate.mockReturnValueOnce(localCandidateFailure);
    local.addIceCandidate.mockReturnValueOnce(remoteCandidateFailure);
    const candidate = {} as RTCIceCandidate;

    local.onicecandidate?.({ candidate } as RTCPeerConnectionIceEvent);
    remote.onicecandidate?.({ candidate } as RTCPeerConnectionIceEvent);
    loopback.destroy();

    expect(localCatch).toHaveBeenCalledOnce();
    expect(remoteCatch).toHaveBeenCalledOnce();
  });
});
