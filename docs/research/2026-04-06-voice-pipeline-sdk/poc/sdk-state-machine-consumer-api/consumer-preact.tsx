// ============================================================
// CONSUMER EXAMPLE — Preact/React hook version (<40 lines)
// Shows how the same state machine integrates with a framework.
// ============================================================

import { useState, useEffect, useRef } from "preact/hooks";
import { VoiceClient, VoiceStatus } from "./state-machine";

/** Hook: gives you voice status + send function. That's the entire API. */
function useVoice() {
  const clientRef = useRef(new VoiceClient());
  const [status, setStatus] = useState<VoiceStatus>(clientRef.current.status);

  useEffect(() => {
    const client = clientRef.current;
    const unsub = client.onStatusChange(setStatus);
    client.connect();
    return () => { unsub(); client.disconnect(); };
  }, []);

  return { status, send: clientRef.current.send.bind(clientRef.current) };
}

/** Full voice UI in one component */
function VoiceAssistant() {
  const { status, send } = useVoice();

  return (
    <div>
      <p>{status.label}</p>
      {status.transcript && <p>"{status.transcript}"</p>}
      {status.canSpeak && (
        <button
          onMouseDown={() => send({ type: "SPEECH_START" })}
          onMouseUp={() => send({ type: "SPEECH_END" })}
        >
          Hold to talk
        </button>
      )}
      {status.state === "error" && (
        <button onClick={() => send({ type: "RETRY" })}>Retry</button>
      )}
    </div>
  );
}

export { useVoice, VoiceAssistant };
