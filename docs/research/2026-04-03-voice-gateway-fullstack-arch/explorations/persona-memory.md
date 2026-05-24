# Persona & Memory System

## Decision Area
Single persona file + per-user memory files with context budgeting.

## Key Questions
- `persona.md` format: system prompt structure, personality traits, behavioral rules?
- `memory/<user>.md` structure: sectioned (core profile / active context / archive)?
- Memory update strategy: end-of-session extraction + explicit "remember this"?
- Extraction prompt design: what LLM call extracts memorable facts?
- Reconciliation: ADD/UPDATE/DELETE operations on memory sections?
- Context budgeting: persona + memory + history ≤ 80% of context window?
- Priority: persona > memory > history — how to enforce truncation order?
- Guest memory: in-memory only, discarded at session end
- Cross-user privacy: path validation, no user A reading user B's memory
- Memory deduplication and staleness detection

## Prior Research
- Python iteration explored sectioned markdown with tiered storage
- Mem0 research: extraction cuts tokens 80-90%, 26% quality improvement over raw history
- Letta/MemGPT: fixed-size memory blocks with character limits per block
- Markdown memory paradigm: file-based beats vector DBs for single-user agents
- Claude Code MEMORY.md pattern: index file + individual memory files with frontmatter
- js-tiktoken: pure JS tokenizer, works on ARM64 without WASM compilation issues

## Approaches

### Approach A: Sectioned Markdown Files (Tiered Storage)

**Description:** Each user gets a `memory/<user>.md` file organized into three sections with explicit token budgets. Memory is human-readable markdown, updated via LLM extraction at end-of-session. A single `persona.md` file defines the assistant's personality and is injected into every LLM call as the system prompt. Context assembly follows a strict priority hierarchy: persona > memory > history, with truncation applied in reverse order.

**Persona file format:**

```markdown
# Persona

You are Aria, a warm and helpful family assistant for the Ye household.

## Personality
- Friendly but not saccharine — natural conversational tone
- Concise in voice responses (aim for <20 seconds of speech unless asked for detail)
- Patient with children, efficient with adults
- Proactive about safety (weather warnings, calendar conflicts)
- Remembers context from prior conversations — reference it naturally

## Behavioral Rules
- Never share one family member's private information with another
- For children: filter news content, no explicit material, encourage learning
- For guests: be helpful but don't reveal family routines or schedules
- Always confirm before executing high-impact actions (purchases, deletions)
- When uncertain, ask — don't guess

## Voice Style
- Use contractions ("I'll", "you're", "let's")
- Avoid bullet points in spoken responses — use natural speech flow
- Numbers: say "about fifteen minutes" not "approximately 14.7 minutes"
- Greetings: vary based on time of day and user's recent activity
```

**Per-user memory file format:**

```markdown
# Kevin

## Core Profile
<!-- Stable facts: name, role, preferences. Rarely changes. ~200 tokens max -->
- Adult, family head
- Software engineer, works from home
- Prefers direct, technical responses
- Morning person — usually active by 6:30am
- Coffee: black, no sugar
- Allergies: none

## Active Context
<!-- Current projects, recent interests, ongoing tasks. Updated frequently. ~300 tokens max -->
- Working on voice gateway project (TypeScript, Raspberry Pi)
- Planning family trip to Japan in July 2026
- Tracking home renovation — kitchen remodel, contractor is Mike
- Currently reading "Project Hail Mary" by Andy Weir

## Conversation Patterns
<!-- How this user interacts, what works well. ~100 tokens max -->
- Often asks follow-up questions — anticipate them
- Prefers code examples over explanations
- Gets frustrated by verbose responses
- Uses "hey" as greeting regardless of time
```

**Token budget allocation:**

```typescript
interface ContextBudget {
  totalLimit: number;          // e.g., 128000 tokens (model context window)
  responseReserve: number;     // e.g., 4000 tokens (for LLM response)
  usableContext: number;       // totalLimit - responseReserve

  // Fixed allocations (never truncated)
  personaBudget: number;       // ~500-800 tokens — immutable
  memoryBudget: number;        // ~600 tokens — per-user, rarely truncated

  // Flexible allocation (truncated when needed)
  skillContext: number;        // ~500 tokens if skill active, 0 otherwise
  historyBudget: number;       // remaining — oldest turns summarized/evicted
}

function calculateBudget(
  model: ModelConfig,
  hasActiveSkill: boolean,
): ContextBudget {
  const totalLimit = model.contextWindow;    // e.g., 128000
  const responseReserve = 4000;
  const usableContext = totalLimit - responseReserve;

  const personaBudget = 800;                 // persona.md — fixed
  const memoryBudget = 600;                  // user memory — fixed
  const skillContext = hasActiveSkill ? 500 : 0;

  const historyBudget = usableContext - personaBudget - memoryBudget - skillContext;
  // 128000 - 4000 - 800 - 600 - 500 = 122,100 tokens for history
  // Even with 80% safety margin: ~97,680 tokens ≈ 100+ conversation turns

  return { totalLimit, responseReserve, usableContext, personaBudget, memoryBudget, skillContext, historyBudget };
}
```

**Context assembly (priority order):**

```typescript
interface AssembledContext {
  systemPrompt: string;     // persona + memory
  messages: Message[];       // conversation history (truncated)
  tools?: ToolSchema[];      // if skill/tools active
}

function assembleContext(
  persona: string,
  userMemory: string,
  history: Message[],
  budget: ContextBudget,
): AssembledContext {
  // 1. Persona is ALWAYS included (highest priority)
  const systemPrompt = persona;
  let usedTokens = estimateTokens(systemPrompt);

  // 2. User memory is ALWAYS included (second priority)
  const memorySection = `\n\n## About ${history[0]?.userId ?? "the user"}\n${userMemory}`;
  const systemWithMemory = systemPrompt + memorySection;
  usedTokens = estimateTokens(systemWithMemory);

  // 3. History fills remaining budget (lowest priority, newest-first)
  const remainingBudget = budget.historyBudget;
  const truncatedHistory = truncateHistory(history, remainingBudget);

  return {
    systemPrompt: systemWithMemory,
    messages: truncatedHistory,
  };
}

function truncateHistory(
  messages: Message[],
  budgetTokens: number,
): Message[] {
  // Keep messages newest-first until budget exhausted
  const kept: Message[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content);
    if (used + msgTokens > budgetTokens) break;
    kept.unshift(messages[i]);
    used += msgTokens;
  }

  // If we dropped messages, prepend a summary of older context
  if (kept.length < messages.length) {
    const droppedCount = messages.length - kept.length;
    kept.unshift({
      role: "system",
      content: `[${droppedCount} earlier messages summarized: ${generateSummaryPlaceholder(messages.slice(0, droppedCount))}]`,
    });
  }

  return kept;
}
```

**Token estimation (simple, fast):**

```typescript
// For budget estimation, chars/4 is sufficient with a 10% safety buffer.
// Exact tokenization (js-tiktoken) is only needed for billing or tight budgets.
function estimateTokens(text: string): number {
  // chars/4 heuristic with 10% safety margin
  return Math.ceil(text.length / 4 * 1.1);
}

// For exact counting (if needed):
// import { encodingForModel } from "js-tiktoken";
// const enc = encodingForModel("claude-3-sonnet");
// function exactTokens(text: string): number {
//   return enc.encode(text).length;
// }
```

**Memory update flow — end-of-session extraction:**

```typescript
interface MemoryOperation {
  type: "ADD" | "UPDATE" | "DELETE";
  section: "core" | "active" | "patterns";
  content: string;
  replaces?: string;   // For UPDATE: the line being replaced
  reason: string;      // Why this change
}

async function extractMemoryUpdates(
  conversation: Message[],
  currentMemory: string,
  userId: string,
): Promise<MemoryOperation[]> {
  const extractionPrompt = `You are a memory extraction system. Analyze this conversation and determine what facts about the user should be remembered for future conversations.

Current memory for ${userId}:
${currentMemory}

Conversation:
${formatConversation(conversation)}

For each fact worth remembering, output a JSON operation:
- ADD: New information not already in memory
- UPDATE: Existing memory item that needs revision (include the exact line being replaced)
- DELETE: Information that is contradicted or the user explicitly asked to forget

Rules:
- Extract atomic, standalone facts (not conversational fragments)
- Core Profile: stable facts (role, preferences, allergies) — changes rarely
- Active Context: current projects, recent interests, ongoing tasks — changes often
- Conversation Patterns: how the user interacts, what works well — changes rarely
- Do NOT add trivial facts (e.g., "user asked about the weather")
- Do NOT duplicate existing memory items
- Prefer UPDATE over ADD+DELETE for revised facts
- If nothing worth remembering, return empty array

Output JSON array of operations:`;

  const result = await llmCall({
    model: "haiku-4.5",  // Cheap model for extraction — ~$0.001/call
    messages: [
      { role: "system", content: extractionPrompt },
    ],
    response_format: { type: "json_object" },
  });

  return parseMemoryOperations(result);
}

async function applyMemoryUpdates(
  userId: string,
  operations: MemoryOperation[],
): Promise<void> {
  if (operations.length === 0) return;

  const filePath = `memory/${userId}.md`;
  let content = await readFile(filePath, "utf-8");

  for (const op of operations) {
    switch (op.type) {
      case "ADD":
        content = addToSection(content, op.section, op.content);
        break;
      case "UPDATE":
        if (op.replaces) {
          content = content.replace(op.replaces, op.content);
        }
        break;
      case "DELETE":
        if (op.replaces) {
          content = content.replace(op.replaces + "\n", "");
        }
        break;
    }
  }

  // Validate token budgets per section aren't exceeded
  content = enforceTokenLimits(content);

  await writeFile(filePath, content, "utf-8");
  auditLog("memory.update", userId, { operations: operations.length });
}

function enforceTokenLimits(content: string): string {
  const sections = parseSections(content);
  const limits = { core: 200, active: 300, patterns: 100 };

  for (const [section, limit] of Object.entries(limits)) {
    const sectionContent = sections[section] ?? "";
    if (estimateTokens(sectionContent) > limit) {
      // Trim oldest entries in section (entries at top are oldest)
      const lines = sectionContent.split("\n").filter(l => l.startsWith("- "));
      while (estimateTokens(lines.join("\n")) > limit && lines.length > 1) {
        lines.shift(); // Remove oldest entry
      }
      sections[section] = lines.join("\n");
    }
  }

  return reconstructMarkdown(sections);
}
```

**Explicit "remember this" trigger:**

```typescript
// Handled in the tool registry as a standard tool
const rememberTool = {
  name: "memory_save",
  description: "Save a specific fact the user asked to remember",
  parameters: {
    fact: { type: "string", description: "The fact to remember" },
    section: { type: "string", enum: ["core", "active", "patterns"], default: "active" },
  },
  impact: "write",  // Auto-approved, no confirmation needed
  handler: async (params: { fact: string; section: string }, session: Session) => {
    const op: MemoryOperation = {
      type: "ADD",
      section: params.section as "core" | "active" | "patterns",
      content: `- ${params.fact}`,
      reason: "User explicitly asked to remember",
    };
    await applyMemoryUpdates(session.userId, [op]);
    return { success: true, output: `I'll remember that.` };
  },
};
```

**Guest memory (ephemeral):**

```typescript
class GuestMemoryStore {
  private sessions = new Map<string, string[]>();

  // Guest memory lives only in RAM — never written to disk
  add(sessionId: string, fact: string): void {
    const facts = this.sessions.get(sessionId) ?? [];
    facts.push(fact);
    this.sessions.set(sessionId, facts);
  }

  get(sessionId: string): string {
    const facts = this.sessions.get(sessionId) ?? [];
    return facts.map(f => `- ${f}`).join("\n");
  }

  // Called when guest session ends
  destroy(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
```

**Cross-user privacy:**

```typescript
function loadUserMemory(userId: string): string {
  // Path validation: prevent directory traversal
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitized !== userId) {
    throw new Error(`Invalid user ID: ${userId}`);
  }

  const filePath = path.join(MEMORY_DIR, `${sanitized}.md`);
  const resolved = path.resolve(filePath);

  // Ensure resolved path is within MEMORY_DIR
  if (!resolved.startsWith(path.resolve(MEMORY_DIR))) {
    throw new Error(`Memory path traversal attempt: ${userId}`);
  }

  try {
    return readFileSync(resolved, "utf-8");
  } catch {
    return ""; // New user — no memory yet
  }
}
```

**Pros:**
- **Human-readable and editable** — family admin can open `memory/kevin.md` and see/edit what the assistant remembers. No database tools needed.
- **Simple implementation** — file read/write, string manipulation, no dependencies beyond the filesystem.
- **Sectioned token budgets** — each section has an explicit limit, preventing memory bloat. Core stays stable, active context churns, patterns evolve slowly.
- **Strict priority hierarchy** — persona is always included, memory always included, history gets the remainder. Context budget is never exceeded.
- **LLM extraction is cheap** — Haiku 4.5 at ~$0.001/extraction, called once per session end (not per turn). 50 sessions/day = $0.05/day = $1.50/month.
- **Guest memory is trivial** — in-memory Map, destroyed on session end, no file operations, no privacy concerns.
- **Path validation prevents cross-user leaks** — sanitization + prefix check = defense in depth.
- **Dedup built into extraction** — the LLM sees current memory when extracting, naturally avoids duplicates.
- **Explicit "remember this" works as a standard tool** — fits the existing tool/skill architecture.

**Cons:**
- **File I/O on every session start** — must read persona.md + memory/<user>.md. For 10 concurrent sessions, this is 20 file reads — trivial on SSD, but still I/O.
- **LLM extraction quality varies** — the extraction prompt may miss important facts or add trivial ones. Needs tuning.
- **No semantic search** — can't query "what does Kevin like?" across memory. Must load the whole file. Fine for <600 tokens, but limits future scaling.
- **Concurrent write conflicts** — if two sessions for the same user end simultaneously, memory updates could conflict. Unlikely for family use but possible.
- **Token estimation imprecision** — chars/4 has ~15-20% error. Could lead to slightly over/under budget. Safety margin handles this.
- **No versioning** — if an extraction goes wrong, previous memory state is lost. Could add git tracking or backups.
- **Staleness detection is manual** — "Working on voice gateway project" stays forever unless the extraction LLM decides to remove it.

**Risk factors:**
- Memory extraction prompt producing low-quality or noisy operations
- Memory files growing beyond token budgets if enforcement is buggy
- Guest-to-family user transition (guest becomes family member, wants to keep session memory)

---

### Approach B: SQLite Per-User with Markdown Export

**Description:** Memory stored in a SQLite database with structured tables for facts, indexed by user, section, and timestamp. A markdown view is generated on-the-fly for injection into LLM context. This gives structured queries, automatic dedup, and temporal ordering while maintaining the human-readable markdown interface.

**Schema:**

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  section TEXT NOT NULL CHECK(section IN ('core', 'active', 'patterns')),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL CHECK(source IN ('extraction', 'explicit', 'system')),
  confidence REAL DEFAULT 1.0  -- LLM extraction confidence
);

CREATE INDEX idx_memories_user ON memories(user_id);
CREATE INDEX idx_memories_section ON memories(user_id, section);

CREATE TABLE memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('ADD', 'UPDATE', 'DELETE')),
  memory_id INTEGER,
  old_content TEXT,
  new_content TEXT,
  reason TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**TypeScript interface:**

```typescript
import Database from "better-sqlite3";
// Or for Bun: import { Database } from "bun:sqlite";

class SQLiteMemoryStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // Better concurrent reads
    this.initSchema();
  }

  getUserMemory(userId: string): string {
    const rows = this.db.prepare(
      "SELECT section, content FROM memories WHERE user_id = ? ORDER BY section, updated_at DESC"
    ).all(userId) as { section: string; content: string }[];

    // Generate markdown view
    const sections: Record<string, string[]> = { core: [], active: [], patterns: [] };
    for (const row of rows) {
      sections[row.section]?.push(`- ${row.content}`);
    }

    return `## Core Profile\n${sections.core.join("\n")}\n\n## Active Context\n${sections.active.join("\n")}\n\n## Conversation Patterns\n${sections.patterns.join("\n")}`;
  }

  addMemory(userId: string, section: string, content: string, source: string): number {
    // Dedup check: exact match within section
    const existing = this.db.prepare(
      "SELECT id FROM memories WHERE user_id = ? AND section = ? AND content = ?"
    ).get(userId, section, content);

    if (existing) return (existing as { id: number }).id;

    const result = this.db.prepare(
      "INSERT INTO memories (user_id, section, content, source) VALUES (?, ?, ?, ?)"
    ).run(userId, section, content, source);

    this.auditLog(userId, "ADD", result.lastInsertRowid as number, null, content, source);
    return result.lastInsertRowid as number;
  }

  updateMemory(id: number, newContent: string, reason: string): void {
    const old = this.db.prepare("SELECT user_id, content FROM memories WHERE id = ?").get(id) as { user_id: string; content: string } | undefined;
    if (!old) return;

    this.db.prepare(
      "UPDATE memories SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(newContent, id);

    this.auditLog(old.user_id, "UPDATE", id, old.content, newContent, reason);
  }

  deleteMemory(id: number, reason: string): void {
    const old = this.db.prepare("SELECT user_id, content FROM memories WHERE id = ?").get(id) as { user_id: string; content: string } | undefined;
    if (!old) return;

    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.auditLog(old.user_id, "DELETE", id, old.content, null, reason);
  }

  // Enforce per-section token limits
  enforceTokenLimits(userId: string): void {
    const limits = { core: 200, active: 300, patterns: 100 };

    for (const [section, limit] of Object.entries(limits)) {
      const rows = this.db.prepare(
        "SELECT id, content FROM memories WHERE user_id = ? AND section = ? ORDER BY updated_at DESC"
      ).all(userId, section) as { id: number; content: string }[];

      let totalTokens = 0;
      for (const row of rows) {
        totalTokens += estimateTokens(row.content);
        if (totalTokens > limit) {
          this.deleteMemory(row.id, `Token limit exceeded for ${section}`);
        }
      }
    }
  }

  private auditLog(userId: string, op: string, memId: number, oldContent: string | null, newContent: string | null, reason: string): void {
    this.db.prepare(
      "INSERT INTO memory_audit (user_id, operation, memory_id, old_content, new_content, reason) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(userId, op, memId, oldContent, newContent, reason);
  }
}
```

**Pros:**
- **Built-in deduplication** — exact match check before insert. No duplicate facts.
- **Temporal ordering** — `updated_at` gives natural staleness detection. Can auto-archive items not updated in 30 days.
- **Audit trail** — every ADD/UPDATE/DELETE is logged with old/new content and reason. Full history.
- **Concurrent-safe** — SQLite WAL mode handles concurrent reads. Write serialization is automatic.
- **Structured queries** — "What does Kevin like?" could be answered by searching content. Future semantic search via FTS5.
- **Automatic token enforcement** — query ordered by recency, stop when budget exhausted.
- **Both Bun and Node support SQLite** — `bun:sqlite` built-in, `better-sqlite3` for Node. Both are synchronous and fast.
- **Markdown export** — LLM still sees clean markdown, same as Approach A.

**Cons:**
- **Not human-editable** — can't open a file and tweak memory. Need a CLI tool or admin interface.
- **Heavier dependency** — SQLite is a database. `better-sqlite3` requires native compilation on ARM64 (usually works but adds build complexity).
- **Overkill for 5-10 users** — SQLite's concurrency, indexing, and query capabilities aren't needed at this scale. A Map with 5 entries is simpler.
- **Schema migration** — adding fields requires migration scripts. Markdown files are schema-free.
- **Guest memory still needs in-memory store** — SQLite doesn't help with ephemeral sessions.
- **Debugging is harder** — `sqlite3 memory.db "SELECT * FROM memories"` vs `cat memory/kevin.md`.
- **Backup complexity** — need to handle SQLite backup (`.backup` or copy WAL), vs just copying .md files.

**Risk factors:**
- `better-sqlite3` compilation issues on RPi5 ARM64 (native addon)
- Database corruption if gateway crashes during write (WAL mitigates but doesn't eliminate)
- Migration complexity as schema evolves

---

### Approach C: Markdown Files + JSON Sidecar Index

**Description:** Keep the human-readable `memory/<user>.md` files as the source of truth (same as Approach A), but add a `memory/<user>.index.json` sidecar file that contains structured metadata for each memory entry — enabling dedup checking, staleness detection, and faster lookups without parsing markdown.

**File structure:**

```
memory/
├── kevin.md           # Human-readable, injected into LLM context
├── kevin.index.json   # Structured metadata for each entry
├── sarah.md
├── sarah.index.json
└── _guests/           # (empty — guests are in-memory only)
```

**Index format:**

```json
{
  "userId": "kevin",
  "lastUpdated": "2026-04-03T15:30:00Z",
  "entries": [
    {
      "id": "core-001",
      "section": "core",
      "content": "Software engineer, works from home",
      "hash": "a1b2c3d4",
      "createdAt": "2026-03-15T10:00:00Z",
      "updatedAt": "2026-03-15T10:00:00Z",
      "source": "extraction"
    },
    {
      "id": "active-003",
      "section": "active",
      "content": "Working on voice gateway project (TypeScript, Raspberry Pi)",
      "hash": "e5f6g7h8",
      "createdAt": "2026-04-01T09:00:00Z",
      "updatedAt": "2026-04-03T15:30:00Z",
      "source": "extraction"
    }
  ]
}
```

**Implementation:**

```typescript
interface MemoryEntry {
  id: string;
  section: "core" | "active" | "patterns";
  content: string;
  hash: string;        // For dedup
  createdAt: string;
  updatedAt: string;
  source: "extraction" | "explicit" | "system";
}

interface MemoryIndex {
  userId: string;
  lastUpdated: string;
  entries: MemoryEntry[];
}

class HybridMemoryStore {
  private indexCache = new Map<string, MemoryIndex>();

  // Read markdown for LLM injection (same as Approach A)
  async getMarkdown(userId: string): Promise<string> {
    return readFile(`memory/${userId}.md`, "utf-8");
  }

  // Apply operations using index for dedup/tracking, then regenerate markdown
  async applyOperations(userId: string, ops: MemoryOperation[]): Promise<void> {
    const index = await this.loadIndex(userId);

    for (const op of ops) {
      switch (op.type) {
        case "ADD": {
          const hash = simpleHash(op.content);
          // Dedup: check if content already exists
          if (index.entries.some(e => e.hash === hash)) continue;

          index.entries.push({
            id: `${op.section}-${Date.now()}`,
            section: op.section,
            content: op.content,
            hash,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: "extraction",
          });
          break;
        }
        case "UPDATE": {
          const entry = index.entries.find(e => e.content === op.replaces);
          if (entry) {
            entry.content = op.content;
            entry.hash = simpleHash(op.content);
            entry.updatedAt = new Date().toISOString();
          }
          break;
        }
        case "DELETE": {
          index.entries = index.entries.filter(e => e.content !== op.replaces);
          break;
        }
      }
    }

    // Enforce token limits per section
    this.enforceTokenLimits(index);

    // Regenerate both files atomically
    index.lastUpdated = new Date().toISOString();
    await this.saveIndex(userId, index);
    await this.generateMarkdown(userId, index);
  }

  private async generateMarkdown(userId: string, index: MemoryIndex): Promise<void> {
    const sections: Record<string, string[]> = { core: [], active: [], patterns: [] };

    for (const entry of index.entries) {
      sections[entry.section]?.push(`- ${entry.content}`);
    }

    const md = `# ${userId}\n\n## Core Profile\n${sections.core.join("\n")}\n\n## Active Context\n${sections.active.join("\n")}\n\n## Conversation Patterns\n${sections.patterns.join("\n")}\n`;

    await writeFile(`memory/${userId}.md`, md, "utf-8");
  }

  // Staleness detection: flag entries not updated in 30 days
  getStaleEntries(index: MemoryIndex, daysThreshold = 30): MemoryEntry[] {
    const threshold = Date.now() - daysThreshold * 86400000;
    return index.entries.filter(e =>
      e.section === "active" && new Date(e.updatedAt).getTime() < threshold
    );
  }
}

function simpleHash(content: string): string {
  // FNV-1a hash — fast, no crypto needed
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
```

**Pros:**
- **Human-readable AND structured** — markdown for humans and LLM, JSON for programmatic operations.
- **Built-in dedup via hash** — no duplicate entries across extractions.
- **Staleness detection** — `updatedAt` timestamps let you flag stale entries for review/removal.
- **No native dependencies** — pure file I/O, no SQLite compilation.
- **Audit-capable** — index tracks when each entry was created/updated and by what source.
- **Markdown is regenerated, not parsed** — the index is the source of truth, markdown is a view. No fragile markdown parsing.

**Cons:**
- **Two files to keep in sync** — if someone edits the .md manually, the index is stale. Need a reconciliation step.
- **More implementation complexity** — Approach A is simpler; this adds index management, hash computation, file sync.
- **Index file is not human-friendly** — JSON sidecar is for the code, not for the user. If they want to edit memory, they edit .md (but then index is stale).
- **Still no semantic search** — hash-based dedup catches exact matches, not semantic duplicates ("likes coffee black" vs "drinks black coffee").
- **Atomic write challenge** — must write both .md and .index.json atomically. Write .json first, then .md; or use a temp file + rename pattern.
- **Over-engineering for 5 users** — the dedup and staleness features may not justify the extra file management.

**Risk factors:**
- Index/markdown desync if manual edits occur
- JSON index growing large over time (though entries are small)
- Reconciliation complexity when both files are modified

---

## Analysis

### Approach comparison

| Dimension | A: Sectioned Markdown | B: SQLite | C: Markdown + JSON Index |
|---|---|---|---|
| Human readability | Best — just a .md file | Poor — need SQL client | Good — .md is readable |
| Implementation complexity | Simplest | Medium — schema, migrations | Medium — dual file sync |
| Deduplication | LLM-driven (soft) | Exact match (hard) | Hash-based (hard) |
| Staleness detection | Manual / LLM-driven | Timestamp queries | Timestamp in index |
| Concurrent safety | File lock or last-write-wins | WAL mode (built-in) | File lock needed |
| Dependencies | None (fs only) | better-sqlite3 or bun:sqlite | None (fs only) |
| Queryability | Load entire file | SQL queries, FTS5 | Load index, filter |
| Audit trail | None (unless git tracked) | Built-in audit table | Index has timestamps |
| Backup | cp *.md | .backup command | cp *.md + *.json |
| Guest memory | In-memory Map | In-memory Map | In-memory Map |
| Scaling (future) | ~10 users max | 100s of users | ~10 users |
| ARM64 compatibility | No issues | Native compilation needed | No issues |
| Disk footprint | ~1KB per user | ~50KB+ database | ~2KB per user |

### Key trade-off: simplicity vs structure

The central tension is between Approach A's simplicity and Approaches B/C's additional structure (dedup, timestamps, audit).

For a family of 5+5 guests:
- **5 memory files, each ~600 tokens** — total memory footprint is ~3000 tokens, ~2.4KB on disk
- **Memory updates happen ~once per session end** — maybe 50 times/day at peak
- **Concurrent writes are extremely rare** — family members don't usually have simultaneous sessions ending at the same instant
- **Semantic dedup matters more than exact dedup** — "likes coffee black" vs "prefers black coffee" is the real dedup challenge, and only the LLM can handle that

At this scale, the structural benefits of B and C don't justify their complexity.

### Why Approach A wins for this project

1. **Simplest possible architecture** — read file, inject into context, done. No schema, no index, no sync. The memory system should be boring infrastructure, not a product feature.

2. **Human-editable is a real feature** — the family admin (Kevin) can open `memory/kevin.md` in any text editor, see what the assistant remembers, and fix it. This is transparency that SQLite and JSON indexes don't provide.

3. **LLM extraction handles dedup** — the extraction prompt includes current memory. The LLM naturally avoids duplicates and prefers UPDATE over ADD. This is "good enough" dedup for 5 users.

4. **Git tracking provides versioning and audit** — put `memory/` under git. Every update is a commit. Full history, diffs, rollback. Better audit trail than a custom audit table.

5. **No native dependencies** — critical for RPi5 ARM64. `better-sqlite3` requires compilation and has had ARM64 issues. Markdown files need only `fs.readFile`.

6. **Context budget is straightforward** — persona.md is ~500-800 tokens (fixed), user memory is ~600 tokens (capped), history gets the rest. At 128K context, there's no budget pressure.

7. **Scales down gracefully** — if a user has no memory file yet, the system works fine with just persona + history. No schema initialization, no empty database.

### Staleness mitigation for Approach A

The main weakness of Approach A is staleness detection. Mitigations:

1. **Extraction prompt includes date awareness**: "Today is {date}. If any Active Context items appear to be from more than 30 days ago based on their content, mark them for DELETE."

2. **Periodic maintenance** (optional, not in MVP): A weekly cron that re-processes each memory file through the LLM with "Review this user's memory for staleness. Remove any Active Context items that are likely outdated."

3. **Active Context is designed to churn** — the section name signals to the extraction LLM that these items are temporary. Core Profile and Conversation Patterns are stable by nature.

## Recommendation

**Approach A: Sectioned Markdown Files (Tiered Storage)** is the strongest choice for the initial architecture.

**Rationale:**

1. **Minimum viable memory** — the memory system needs to work, not be sophisticated. Read a file, inject it, write updates at session end. The LLM handles the hard parts (extraction, dedup, reconciliation).

2. **Human-editable is uniquely valuable** — no other approach lets you `vim memory/kevin.md` and directly see/fix what the assistant knows. For a family project where the builder is the admin, this matters.

3. **No dependencies beyond fs** — no native modules, no database, no build steps. Works identically on Node and Bun, on x86 and ARM64.

4. **Extraction cost is negligible** — Haiku 4.5 at ~$0.001/extraction × 50 sessions/day = $1.50/month. Even with quality tuning iterations, this is within budget.

5. **Context budget is a non-issue at 128K** — persona (~700 tokens) + memory (~600 tokens) + skill context (~500 tokens) = ~1800 tokens fixed overhead. That's 1.4% of the context window. History gets 97%+ of available context.

6. **Git tracking provides the audit trail and versioning** that Approaches B and C build in as features. `git log --follow memory/kevin.md` gives full history.

**Key implementation decisions:**
- Persona format: markdown with # Personality, ## Behavioral Rules, ## Voice Style sections
- Memory format: markdown with ## Core Profile (~200 tokens), ## Active Context (~300 tokens), ## Conversation Patterns (~100 tokens) per user
- Token estimation: chars/4 with 10% safety buffer (fast, sufficient for budgeting)
- Context priority: persona (fixed) > memory (fixed) > skill context (if active) > history (fills remainder, newest-first)
- History truncation: newest-first fill, prepend summary of dropped messages
- Memory extraction: end-of-session LLM call (Haiku 4.5) with current memory in prompt for dedup
- Explicit "remember this": standard tool in tool registry, ADD to Active Context
- Guest memory: in-memory Map<sessionId, string[]>, destroyed on session end
- Cross-user privacy: user ID sanitization + path prefix validation
- Staleness: date-aware extraction prompt + optional periodic maintenance
- Versioning: git tracking of memory/ directory (not in MVP, easy to add)

## Open Questions

- How to handle the first interaction with a new family member (no memory file yet)? Auto-create from auth token claims (name, role)?
- Should the extraction prompt be configurable per-user (e.g., "remember more about my work projects")?
- How long should conversation history be retained on disk vs just in session memory? Separate from the user memory question.
- Should there be a "forget everything about me" tool for privacy? What about GDPR-style data deletion?
- How to handle memory when the persona.md is updated? Does the assistant's behavior change mid-session or only on next session?
- Should memory extraction happen on every turn (incremental) or only at session end (batch)? Batch is simpler and cheaper, but misses facts if the session crashes.
- What's the right Haiku vs Sonnet tradeoff for extraction quality vs cost?
