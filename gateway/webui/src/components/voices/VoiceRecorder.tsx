// gateway/webui/src/components/voices/VoiceRecorder.tsx
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { createWebAudioCapture } from "../../adapters/web-audio-capture.ts";
import { encodeWav } from "../../audio/wav-encoder.ts";
import { CAPTURE_SAMPLE_RATE } from "../../constants.ts";
import { TextField } from "../settings/primitives/text-field.tsx";
import { Btn } from "../settings/primitives/btn.tsx";
import { Icon } from "../common/icon.tsx";

const log = createLogger(["sentient", "webui", "voices", "recorder"]);

/** Service hard floor is >5s (CONTRACT.md §4.1) — enforce a soft minimum in
 *  the UI so the common too-short-clip failure is caught before upload. */
const MIN_RECORDING_SECONDS = 6;
const TIMER_TICK_MS = 200;
const MS_PER_SECOND = 1000;

export interface VoiceRecorderProps {
  onCreate: (audio: Blob, name: string) => Promise<void>;
  /** True while a create/delete/set-active op is in flight elsewhere in the panel. */
  busy: boolean;
}

type RecorderState = "idle" | "recording" | "denied" | "review";

export function VoiceRecorder({ onCreate, busy }: VoiceRecorderProps): JSX.Element {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [name, setName] = useState("");
  const [deniedMessage, setDeniedMessage] = useState<string | null>(null);
  const captureRef = useRef<ReturnType<typeof createWebAudioCapture> | null>(null);
  const framesRef = useRef<Int16Array[]>([]);
  const startedAtRef = useRef(0);
  const blobRef = useRef<Blob | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => stopCapture, []);

  function stopCapture(): void {
    if (tickRef.current !== null) clearInterval(tickRef.current);
    tickRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
  }

  async function startRecording(): Promise<void> {
    setDeniedMessage(null);
    framesRef.current = [];
    const capture = createWebAudioCapture();
    captureRef.current = capture;
    capture.onAudioData((buf) => framesRef.current.push(new Int16Array(buf)));
    capture.onError((message) => {
      log.warn("capture.error", { message });
      setDeniedMessage(message);
      setState("denied");
      stopCapture();
    });
    try {
      await capture.start();
    } catch (err) {
      log.warn("capture.start-failed", { err: String(err) });
      setState("denied");
      return;
    }
    log.info("recording.started", {});
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setState("recording");
    tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), TIMER_TICK_MS);
  }

  function finishRecording(): void {
    const frameCount = framesRef.current.length;
    const durationMs = elapsedMs;
    stopCapture();
    blobRef.current = encodeWav(framesRef.current, CAPTURE_SAMPLE_RATE);
    log.info("recording.finished", { durationMs, frames: frameCount });
    setState("review");
  }

  async function handleCreate(): Promise<void> {
    const audio = blobRef.current;
    const trimmedName = name.trim();
    if (!audio || !trimmedName) return;
    await onCreate(audio, trimmedName);
    reset();
  }

  function reset(): void {
    blobRef.current = null;
    framesRef.current = [];
    setName("");
    setElapsedMs(0);
    setState("idle");
  }

  if (state === "denied") {
    return (
      <div class="voices-rec voices-rec--denied">
        <p class="pane-error">
          {deniedMessage ?? "Microphone access denied."} Use the upload option below instead.
        </p>
      </div>
    );
  }

  if (state === "review") {
    return (
      <div class="voices-rec">
        <p class="voices-rec-hint">Recorded {(elapsedMs / MS_PER_SECOND).toFixed(1)}s. Name this voice to save it.</p>
        <div class="voices-rec-row">
          <TextField
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="e.g. Dad"
            fullWidth
          />
          <Btn kind="secondary" size="sm" onClick={reset} disabled={busy}>
            Discard
          </Btn>
          <Btn kind="primary" size="sm" onClick={() => void handleCreate()} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save voice"}
          </Btn>
        </div>
      </div>
    );
  }

  if (state === "recording") {
    const seconds = elapsedMs / MS_PER_SECOND;
    const canFinish = seconds >= MIN_RECORDING_SECONDS;
    return (
      <div class="voices-rec voices-rec--live">
        <span class="voices-rec-dot" aria-hidden="true" />
        <span class="voices-rec-time">{seconds.toFixed(1)}s</span>
        <Btn kind="primary" size="sm" onClick={finishRecording} disabled={!canFinish}>
          Use recording
        </Btn>
        <Btn
          kind="ghost"
          size="sm"
          onClick={() => {
            stopCapture();
            reset();
          }}
        >
          Cancel
        </Btn>
        {!canFinish && (
          <span class="voices-rec-hint">Record at least {MIN_RECORDING_SECONDS}s to continue.</span>
        )}
      </div>
    );
  }

  return (
    <div class="voices-rec">
      <Btn
        kind="primary"
        size="sm"
        icon={<Icon name="mic" size={12} />}
        onClick={() => void startRecording()}
        disabled={busy}
      >
        Record
      </Btn>
      <span class="voices-rec-hint">Record ~10–15s of clear speech.</span>
    </div>
  );
}
