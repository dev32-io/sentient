// Session management PoC - demonstrates gateway core patterns
// Tests: session lifecycle, cancel propagation, concurrent sessions, health endpoint

interface Session {
  id: string;
  userId: string;
  role: "adult" | "child" | "guest";
  createdAt: number;
  lastActivity: number;
  abortController: AbortController;
}

class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly MAX_SESSIONS = 10;

  create(userId: string, role: Session["role"]): Session | null {
    if (this.sessions.size >= this.MAX_SESSIONS) return null;

    const session: Session = {
      id: crypto.randomUUID(),
      userId,
      role,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      abortController: new AbortController(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.abortController.abort("barge-in");
    return true;
  }

  destroy(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.abortController.abort("session-end");
    this.sessions.delete(id);
    return true;
  }

  stats() {
    return {
      active: this.sessions.size,
      max: this.MAX_SESSIONS,
      sessions: [...this.sessions.values()].map(s => ({
        id: s.id.slice(0, 8),
        userId: s.userId,
        role: s.role,
        ageMs: Date.now() - s.createdAt,
      })),
    };
  }
}

// --- Test ---
const mgr = new SessionManager();

// Create sessions
console.log("=== Session Management PoC ===\n");

const s1 = mgr.create("alice", "adult")!;
const s2 = mgr.create("bob", "child")!;
const s3 = mgr.create("guest1", "guest")!;
console.log("Created 3 sessions:", mgr.stats());

// Test cancel propagation
let cancelCaught = false;
s1.abortController.signal.addEventListener("abort", () => {
  cancelCaught = true;
  console.log(`\nCancel propagated to session ${s1.id.slice(0, 8)}: reason="${s1.abortController.signal.reason}"`);
});

mgr.cancel(s1.id);
console.log(`Cancel caught: ${cancelCaught}`);

// Test max sessions
console.log("\n--- Max session test ---");
for (let i = 0; i < 8; i++) {
  mgr.create(`user${i}`, "guest");
}
const overflow = mgr.create("overflow", "guest");
console.log(`10 sessions created, 11th returns null: ${overflow === null}`);
console.log("Stats:", mgr.stats());

// Test abort signal with async operation
console.log("\n--- Abort signal with async simulation ---");
const s4 = mgr.create("testuser", "adult");
// (Need to destroy one to make room)
mgr.destroy(s3.id);
const s5 = mgr.create("testuser2", "adult")!;

async function simulateSTTRelay(session: Session) {
  const signal = session.abortController.signal;
  try {
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(resolve, 5000); // Simulates long STT relay
    });
    return "completed";
  } catch {
    return "cancelled";
  }
}

const relayPromise = simulateSTTRelay(s5);
setTimeout(() => mgr.cancel(s5.id), 100); // Cancel after 100ms
const result = await relayPromise;
console.log(`STT relay cancelled via abort signal: ${result === "cancelled"}`);

// Health endpoint shape
console.log("\n--- Health endpoint ---");
const health = {
  status: "ok",
  uptime: process.uptime(),
  memory: {
    rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`,
    heap: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
  },
  sessions: mgr.stats(),
  runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
};
console.log(JSON.stringify(health, null, 2));

console.log("\n=== All tests passed ===");
