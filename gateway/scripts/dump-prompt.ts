// Standalone prompt dumper — builds the exact LLMRequest the model would
// see for a given simulated scenario, using the REAL persona.md,
// system_prompts/system_prompt.md, and priority template. No docker rebuild
// needed: run with `bun run scripts/dump-prompt.ts` from the gateway/ dir.
//
// Edit the SCENARIO block below to simulate different conversation states.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContextAssembler, type AssemblerConfig } from "../src/cerebrum/context-assembler.ts";
import { createConversationHistory } from "../src/cerebrum/conversation-history.ts";
import type { EffectDefinition } from "../src/effects/effect-types.ts";
import type { Projection } from "../src/cerebrum/short-term-context-types.ts";

// ---------------------------------------------------------------------------
// Load the real prompt files
// ---------------------------------------------------------------------------

const gatewayRoot = join(import.meta.dir, "..");
const persona = readFileSync(join(gatewayRoot, "persona.md"), "utf-8");
const systemPrompt = readFileSync(join(gatewayRoot, "system_prompts", "system_prompt.md"), "utf-8");

// ---------------------------------------------------------------------------
// Minimal effect registry — matches what ws-session-configure registers on a
// real session: configure, cancel_all_tasks, cancel_task, speak (alwaysAvailable).
// ---------------------------------------------------------------------------

function stub(name: string, description: string, alwaysAvailable = true, terminal = false): EffectDefinition {
  return {
    name,
    description,
    schema: { type: "object", properties: {}, additionalProperties: true },
    argsValidator: (raw) => raw,
    impact: "auto",
    rolesAllowed: ["adult", "child"],
    capabilities: [],
    interruptable: true,
    providesContext: false,
    ...(alwaysAvailable ? { alwaysAvailable: true } : {}),
    ...(terminal ? { terminal: true } : {}),
    handler: async () => ({ ok: true, data: {} }),
  };
}

const effects: EffectDefinition[] = [
  stub("configure", "Adjust session preferences (language, channel)."),
  stub("cancel_all_tasks", "Cancel every running interruptable task."),
  stub("cancel_task", "Cancel one specific task by id."),
  stub(
    "speak",
    "Speak text aloud to the user. Provide TTS-friendly prose (strip markdown, code, URLs; preserve punctuation for pacing). Use when the user should HEAR your reply; check the Session Preferences `channel` setting (text = skip, voice = prefer, auto = decide by context).",
    true,
    true,
  ),
];

// ---------------------------------------------------------------------------
// SCENARIO — edit this block to simulate different states.
// Default: user just typed "can you speak" in a fresh session.
// ---------------------------------------------------------------------------

const history = createConversationHistory({ maxEntries: 1000 });
history.append({ kind: "user", channel: "text", content: "can you speak" });

const projection: Projection = {
  situationAwareness: {
    perceivedInputs: [
      {
        source: "user",
        kind: "text",
        summary: "can you speak",
        ts: Date.now(),
      },
    ],
    tonicSummary: "",
    comprehension: "",
  },
  salienceByEffect: {},
  phasicEvents: [],
  tonicState: {
    userPresence: "home",
    lastInteractionAgeMs: 0,
    isTtsPlaying: false,
    sessionStartedAtMs: Date.now() - 60_000,
    runningEffects: [],
  },
  windowSeqRange: { from: 0, to: 1 },
  taskTable: [],
  resultsById: {},
};

// ---------------------------------------------------------------------------
// Build the assembler config exactly like ws-session-configure does
// ---------------------------------------------------------------------------

const config: AssemblerConfig = {
  persona,
  systemPrompt,
  chatModel: "google/gemini-3.1-flash-lite-preview",
  maxTokens: 1024,
  historyMaxTokens: 4096,
  standardThreshold: 50,
};

// ---------------------------------------------------------------------------
// Assemble + print
// ---------------------------------------------------------------------------

const assembler = createContextAssembler(config);
const request = assembler.assemble(projection, effects, {
  conversationHistory: history,
  preferences: { language: "en", channel: "auto" },
});

console.log("=".repeat(78));
console.log("EXACT LLM REQUEST — assembled for scenario above");
console.log("=".repeat(78));
console.log();
console.log("model:", request.model);
console.log("max_tokens:", request.max_tokens);
console.log("tool_choice:", request.tool_choice ?? "(unset)");
console.log("tools:", request.tools?.length ?? 0, "exposed");
if (request.tools) {
  for (const t of request.tools) {
    console.log(`  - ${t.function.name}`);
  }
}
console.log();
console.log("messages:", request.messages.length);
console.log();

for (let i = 0; i < request.messages.length; i++) {
  const m = request.messages[i];
  if (!m) continue;
  console.log("-".repeat(78));
  console.log(`[${i}] role=${m.role}`);
  console.log("-".repeat(78));
  if (typeof m.content === "string") {
    console.log(m.content);
  } else {
    console.log(JSON.stringify(m.content, null, 2));
  }
  console.log();
}

console.log("=".repeat(78));
console.log("END");
console.log("=".repeat(78));
