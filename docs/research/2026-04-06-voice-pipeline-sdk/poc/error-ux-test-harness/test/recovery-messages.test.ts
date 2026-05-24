import { describe, test, expect } from "bun:test";
import {
  resolveRecovery,
  isAutoRecoverable,
  userMessage,
  recoveryTimeout,
  type UserErrorCategory,
  type RecoveryType,
} from "../src/error-ux";

// --- Recovery Resolution ---

describe("resolveRecovery — deterministic", () => {
  const EXPECTED_MAP: Record<UserErrorCategory, RecoveryType> = {
    connection_lost:     "auto_reconnect",
    didnt_catch:         "reset_to_listening",
    thinking_timeout:    "retry_once",
    service_unavailable: "wait_and_retry",
    auth_required:       "require_auth",
    try_again:           "prompt_retry",
  };

  const ALL_CATEGORIES: UserErrorCategory[] = [
    "connection_lost", "didnt_catch", "thinking_timeout",
    "service_unavailable", "auth_required", "try_again",
  ];

  for (const cat of ALL_CATEGORIES) {
    test(`${cat} → ${EXPECTED_MAP[cat]}`, () => {
      expect(resolveRecovery(cat)).toBe(EXPECTED_MAP[cat]);
    });
  }

  test("every category has exactly one recovery type", () => {
    for (const cat of ALL_CATEGORIES) {
      const result = resolveRecovery(cat);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    }
  });
});

// --- Auto-Recoverability ---

describe("isAutoRecoverable", () => {
  test("auto_reconnect, reset_to_listening, retry_once are auto-recoverable", () => {
    expect(isAutoRecoverable("auto_reconnect")).toBe(true);
    expect(isAutoRecoverable("reset_to_listening")).toBe(true);
    expect(isAutoRecoverable("retry_once")).toBe(true);
  });

  test("wait_and_retry, require_auth, prompt_retry require user action", () => {
    expect(isAutoRecoverable("wait_and_retry")).toBe(false);
    expect(isAutoRecoverable("require_auth")).toBe(false);
    expect(isAutoRecoverable("prompt_retry")).toBe(false);
  });

  test("auto-recoverable errors go to auto_recovering, non-auto go to awaiting_user", () => {
    // This is a cross-cutting invariant: the state machine MUST route based on this
    const AUTO_CATEGORIES: UserErrorCategory[] = ["connection_lost", "didnt_catch", "thinking_timeout"];
    const USER_CATEGORIES: UserErrorCategory[] = ["service_unavailable", "auth_required", "try_again"];

    for (const cat of AUTO_CATEGORIES) {
      expect(isAutoRecoverable(resolveRecovery(cat))).toBe(true);
    }
    for (const cat of USER_CATEGORIES) {
      expect(isAutoRecoverable(resolveRecovery(cat))).toBe(false);
    }
  });
});

// --- User Messages ---

describe("userMessage — friendly, no jargon", () => {
  const ALL_CATEGORIES: UserErrorCategory[] = [
    "connection_lost", "didnt_catch", "thinking_timeout",
    "service_unavailable", "auth_required", "try_again",
  ];

  test("every category has a non-empty message", () => {
    for (const cat of ALL_CATEGORIES) {
      const msg = userMessage(cat);
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test("no message contains technical jargon", () => {
    const JARGON = [
      "stt", "tts", "llm", "websocket", "ws", "tcp", "http", "500", "502",
      "exception", "stack", "trace", "null", "undefined", "error code",
      "deepgram", "openrouter", "fish audio", "provider", "pipeline",
    ];
    for (const cat of ALL_CATEGORIES) {
      const msg = userMessage(cat).toLowerCase();
      for (const term of JARGON) {
        expect(msg).not.toContain(term);
      }
    }
  });

  test("every message is a complete sentence (ends with punctuation)", () => {
    for (const cat of ALL_CATEGORIES) {
      const msg = userMessage(cat);
      const lastChar = msg[msg.length - 1];
      expect([".", "?", "!"].includes(lastChar)).toBe(true);
    }
  });

  test("connection_lost message implies auto-recovery", () => {
    const msg = userMessage("connection_lost").toLowerCase();
    expect(msg).toContain("reconnect");
  });

  test("didnt_catch message invites user to repeat", () => {
    const msg = userMessage("didnt_catch").toLowerCase();
    expect(msg).toContain("repeat");
  });

  test("auth_required message asks to sign in", () => {
    const msg = userMessage("auth_required").toLowerCase();
    expect(msg).toContain("sign in");
  });
});

// --- Recovery Timeouts ---

describe("recoveryTimeout", () => {
  const ALL_RECOVERIES: RecoveryType[] = [
    "auto_reconnect", "reset_to_listening", "retry_once",
    "wait_and_retry", "require_auth", "prompt_retry",
  ];

  test("every recovery type has a positive timeout", () => {
    for (const r of ALL_RECOVERIES) {
      expect(recoveryTimeout(r)).toBeGreaterThan(0);
    }
  });

  test("reset_to_listening is the fastest (<= all others)", () => {
    const fastest = recoveryTimeout("reset_to_listening");
    for (const r of ALL_RECOVERIES) {
      expect(fastest).toBeLessThanOrEqual(recoveryTimeout(r));
    }
  });

  test("require_auth has the longest timeout (user must act)", () => {
    const longest = recoveryTimeout("require_auth");
    for (const r of ALL_RECOVERIES) {
      expect(longest).toBeGreaterThanOrEqual(recoveryTimeout(r));
    }
  });

  test("auto-recoverable timeouts are shorter than user-action timeouts", () => {
    const autoMax = Math.max(
      recoveryTimeout("auto_reconnect"),
      recoveryTimeout("reset_to_listening"),
      recoveryTimeout("retry_once"),
    );
    const userMin = Math.min(
      recoveryTimeout("wait_and_retry"),
      recoveryTimeout("require_auth"),
      recoveryTimeout("prompt_retry"),
    );
    expect(autoMax).toBeLessThanOrEqual(userMin);
  });
});
