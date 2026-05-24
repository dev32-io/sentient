export type ProcessingStage = "silent" | "thinking" | "still_thinking" | "taking_long" | "timeout";

export interface ProcessingStageEvent {
  stage: ProcessingStage;
  elapsedMs: number;
}

interface StageConfig {
  stage: ProcessingStage;
  ms: number;
}

const STAGES: StageConfig[] = [
  { stage: "thinking", ms: 2000 },
  { stage: "still_thinking", ms: 5000 },
  { stage: "taking_long", ms: 15000 },
  { stage: "timeout", ms: 30000 },
];

export function createProcessingTimer(onStage: (event: ProcessingStageEvent) => void): { cancel: () => void } {
  const timers: ReturnType<typeof setTimeout>[] = [];

  for (const { stage, ms } of STAGES) {
    timers.push(setTimeout(() => onStage({ stage, elapsedMs: ms }), ms));
  }

  return {
    cancel() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
