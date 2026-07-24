// The stimulus-source seam (spec §4.4, Plan 2 Task 6).
//
// A stimulus is "something was appended to the store that the model should
// see." The skeleton wires two kinds now — a conversational message and a
// background-task completion — but the seam is source-agnostic by design:
// later sources (ambient sensors, the re-architected attention model,
// explicit user mid-turn steer) attach here without touching the ReAct
// loop's core (react-loop.ts). The loop itself never imports this file — it
// only re-reads the store at the top of every iteration (spec §4.5: "the
// store is the queue"), which is what makes every stimulus source steer for
// free, regardless of where it landed from.

export type Stimulus = { kind: "conversational"; text: string } | { kind: "background-completion"; note: string };

/**
 * A stimulus producer. `emit` is called once per stimulus observed; the
 * source manages its own subscription lifecycle and returns an unsubscribe
 * function. The caller (SessionRuntime, Task 7) decides whether an emitted
 * stimulus steers the running turn or starts the next one — this seam
 * carries no salience, gate, or debounce logic itself.
 */
export type StimulusSource = (emit: (s: Stimulus) => void) => () => void;
