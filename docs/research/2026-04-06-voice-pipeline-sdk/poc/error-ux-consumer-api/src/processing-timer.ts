// Staged processing indicators — never leave user staring at nothing

export type ProcessingStage = "silent" | "thinking" | "still_thinking" | "taking_long" | "timeout";

export interface ProcessingEvent {
  stage: ProcessingStage;
  elapsed: number;
  message: string | null;
}

const STAGES: Array<{ at: number; stage: ProcessingStage; message: string | null }> = [
  { at: 0,     stage: "silent",         message: null },
  { at: 2000,  stage: "thinking",       message: "Thinking..." },
  { at: 5000,  stage: "still_thinking", message: "Still thinking..." },
  { at: 15000, stage: "taking_long",    message: "Taking longer than usual..." },
  { at: 30000, stage: "timeout",        message: "Sorry, I'm having trouble. Could you try again?" },
];

export function createProcessingTimer(
  onStage: (event: ProcessingEvent) => void
): { cancel: () => void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const start = Date.now();

  for (const { at, stage, message } of STAGES) {
    const timer = setTimeout(() => {
      onStage({ stage, elapsed: Date.now() - start, message });
    }, at);
    timers.push(timer);
  }

  return {
    cancel() {
      timers.forEach(clearTimeout);
    },
  };
}
