# Audio — Details & Examples

## Toggle-to-Talk State Machine

```
idle → (click) → recording → (click) → processing → idle
                     ↓
              (error/timeout)
                     ↓
                   idle
```

## MediaRecorder Capture

```typescript
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(stream, {
  mimeType: "audio/webm;codecs=opus",
});

recorder.ondataavailable = (e) => {
  if (e.data.size > 0) ws.send(e.data); // binary frame
};

recorder.start(100); // 100ms timeslice
```

## AudioWorklet Ring Buffer

The ring buffer holds ~2 seconds of audio (96KB at 48kHz).
On overflow, oldest samples are dropped (acceptable for real-time audio).
On barge-in, the buffer is cleared in under one process() cycle (~2.67ms at 128 samples).
