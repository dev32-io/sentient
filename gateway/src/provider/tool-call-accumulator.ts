// Accumulates streaming OpenAI tool_call deltas. Keyed by INDEX (the only
// field guaranteed on every delta); id/name/arguments are late-bound as they
// arrive. flush() drains and resets. Prior art: keying on id double-dispatches
// when a provider sends index+name before id.
import type { ChatToolCall } from "../store/model-projection.js";

export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export class ToolCallAccumulator {
  private readonly pending = new Map<number, { id: string; name: string; arguments: string }>();

  feed(deltas: ToolCallDelta[]): void {
    for (const d of deltas) {
      const cur = this.pending.get(d.index) ?? { id: "", name: "", arguments: "" };
      if (d.id) cur.id = d.id;
      if (d.function?.name) cur.name += d.function.name;
      if (d.function?.arguments) cur.arguments += d.function.arguments;
      this.pending.set(d.index, cur);
    }
  }

  flush(): ChatToolCall[] {
    const out: ChatToolCall[] = [];
    for (const [, c] of this.pending) {
      if (!c.id || !c.name) continue; // never emit a half-formed call
      out.push({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } });
    }
    this.pending.clear();
    return out;
  }
}
