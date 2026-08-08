import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUseVoices } from "./use-voices.ts";

// Helper to build a minimal fetch-compatible mock, matching the convention
// used by shared/web-sdk/src/sessions-rest.test.ts.
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return vi.fn(impl) as unknown as typeof globalThis.fetch;
}

const PROFILE_BODY = {
  schemaVersion: 1,
  userId: "u-1",
  model: { provider: "ollama-cloud", id: "m1" },
  voice: { provider: "local-tts", id: "v-old" },
  audio: { ttsEnabled: true, channel: "voice" },
  persona: { template: "default", overrides: "" },
  tools: {},
  compression: { threshold: 0.5 },
  advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
};

describe("createUseVoices", () => {
  let calls: Array<{ url: string; init: RequestInit | undefined }>;

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stub(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
    vi.stubGlobal(
      "fetch",
      mockFetch(async (url, init) => {
        calls.push({ url, init });
        return impl(url, init);
      }),
    );
  }

  it("load() fetches the voice list", async () => {
    stub(async () => Response.json({ voices: [{ voiceId: "v-1", name: "Dad", createdAt: 1, refDurationMs: 12000 }] }));
    const hook = createUseVoices({ token: "t", initialActiveId: "default", onActiveVoiceChanged: vi.fn() });
    await hook.load();
    expect(hook.voices.value).toEqual([{ voiceId: "v-1", name: "Dad", createdAt: 1, refDurationMs: 12000 }]);
    expect(hook.loading.value).toBe(false);
    expect(hook.error.value).toBeNull();
  });

  it("load() sets an error when the request fails", async () => {
    stub(async () => Response.json({ error: "network-error" }, { status: 500 }));
    const hook = createUseVoices({ token: "t", initialActiveId: "default", onActiveVoiceChanged: vi.fn() });
    await hook.load();
    expect(hook.error.value).toBeTruthy();
    expect(hook.voices.value).toBeNull();
  });

  it("createVoice POSTs multipart form data (incl. description/tags), refetches, and becomes active", async () => {
    let postSeen = false;
    let capturedDescription: string | null = null;
    let capturedTags: string[] = [];
    stub(async (url, init) => {
      if (init?.method === "POST") {
        postSeen = true;
        expect(url).toBe("/api/v1/voices");
        expect(init.body).toBeInstanceOf(FormData);
        const form = init.body as FormData;
        capturedDescription = form.get("description") as string;
        capturedTags = form.getAll("tags") as string[];
        return Response.json({ voiceId: "v-new", name: "Dad" });
      }
      return Response.json({
        voices: [
          {
            voiceId: "v-new",
            name: "Dad",
            description: "Warm and calm",
            tags: ["calm", "warm"],
            source: "user",
            createdAt: 2,
            refDurationMs: 15000,
          },
        ],
      });
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "default", onActiveVoiceChanged });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    const result = await hook.createVoice(blob, "Dad", "Warm and calm", ["calm", "warm"], "en");

    expect(postSeen).toBe(true);
    expect(capturedDescription).toBe("Warm and calm");
    expect(capturedTags).toEqual(["calm", "warm"]);
    expect(result.ok).toBe(true);
    expect(hook.voices.value).toEqual([
      {
        voiceId: "v-new",
        name: "Dad",
        description: "Warm and calm",
        tags: ["calm", "warm"],
        source: "user",
        createdAt: 2,
        refDurationMs: 15000,
      },
    ]);
    expect(hook.activeId.value).toBe("v-new");
    expect(onActiveVoiceChanged).toHaveBeenCalledWith("v-new");
  });

  it("createVoice leaves the list unchanged and reports failure on a rejected clip", async () => {
    stub(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ error: "clip-too-short" }, { status: 422 });
      throw new Error("load should not be called after a failed create");
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "v-old", onActiveVoiceChanged });
    const result = await hook.createVoice(new Blob(), "Dad", "", [], "");

    expect(result.ok).toBe(false);
    expect(hook.voices.value).toBeNull();
    expect(hook.activeId.value).toBe("v-old");
    expect(onActiveVoiceChanged).not.toHaveBeenCalled();
  });

  it("createVoice with a not-activated warning does NOT mark the pack active", async () => {
    // The pack exists but the server did not persist profile.voice.id, so the
    // server still synthesizes in the prior voice. Optimistically marking it
    // active would contradict the server and the "activation failed" toast.
    stub(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ voiceId: "v-new", name: "Dad", warning: "not-activated" });
      return Response.json({ voices: [{ voiceId: "v-new", name: "Dad", createdAt: 2, refDurationMs: 15000 }] });
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "v-old", onActiveVoiceChanged });
    const result = await hook.createVoice(new Blob(), "Dad", "", [], "");
    expect(result.ok).toBe(true);
    expect(result.warning).toBe("not-activated");
    expect(hook.activeId.value).toBe("v-old");
    expect(onActiveVoiceChanged).not.toHaveBeenCalled();
  });

  it("deleteVoice of the active pack with a profile-not-updated warning does NOT reset to default", async () => {
    // The pack is gone but the server did not persist the reset, so its profile
    // still points at the now-deleted id. Showing "default" active would be a lie.
    stub(async (_url, init) => {
      if (init?.method === "DELETE") return Response.json({ voiceId: "v-1", warning: "profile-not-updated" });
      return Response.json({ voices: [] });
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "v-1", onActiveVoiceChanged });
    const result = await hook.deleteVoice("v-1");
    expect(result.ok).toBe(true);
    expect(result.warning).toBe("profile-not-updated");
    expect(hook.activeId.value).toBe("v-1");
    expect(onActiveVoiceChanged).not.toHaveBeenCalled();
  });

  it("deleteVoice removes the pack and falls back to default when it was active", async () => {
    stub(async (_url, init) => {
      if (init?.method === "DELETE") return Response.json({ voiceId: "v-1" });
      return Response.json({ voices: [] });
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "v-1", onActiveVoiceChanged });
    const result = await hook.deleteVoice("v-1");

    expect(result.ok).toBe(true);
    expect(hook.voices.value).toEqual([]);
    expect(hook.activeId.value).toBe("default");
    expect(onActiveVoiceChanged).toHaveBeenCalledWith("default");
  });

  it("deleteVoice leaves the active id untouched when the deleted pack was inactive", async () => {
    stub(async (_url, init) => {
      if (init?.method === "DELETE") return Response.json({ voiceId: "v-2" });
      return Response.json({ voices: [{ voiceId: "v-1", name: "Dad", createdAt: 1, refDurationMs: 12000 }] });
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "v-1", onActiveVoiceChanged });
    const result = await hook.deleteVoice("v-2");

    expect(result.ok).toBe(true);
    expect(hook.activeId.value).toBe("v-1");
    expect(onActiveVoiceChanged).not.toHaveBeenCalled();
  });

  it("setActiveVoice reads the profile, writes the new voice, and syncs the caller", async () => {
    stub(async (_url, init) => {
      if (init?.method === "GET") return Response.json(PROFILE_BODY);
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        expect(body.voice).toEqual({ provider: "local-tts", id: "v-2" });
        return Response.json({ ...PROFILE_BODY, voice: { provider: "local-tts", id: "v-2" } });
      }
      throw new Error(`unexpected method ${init?.method}`);
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "v-old", onActiveVoiceChanged });
    const result = await hook.setActiveVoice("v-2");

    expect(result.ok).toBe(true);
    expect(hook.activeId.value).toBe("v-2");
    expect(onActiveVoiceChanged).toHaveBeenCalledWith("v-2");
  });

  it("setActiveVoice fails without syncing when the profile write errors", async () => {
    stub(async (_url, init) => {
      if (init?.method === "GET") return Response.json(PROFILE_BODY);
      return Response.json({ error: "invalid-profile" }, { status: 422 });
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "v-old", onActiveVoiceChanged });
    const result = await hook.setActiveVoice("v-2");

    expect(result.ok).toBe(false);
    expect(hook.activeId.value).toBe("v-old");
    expect(onActiveVoiceChanged).not.toHaveBeenCalled();
  });

  it("syncActiveId updates the local active id without fetching or notifying the caller", () => {
    stub(async () => {
      throw new Error("syncActiveId must not touch the network");
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "default", onActiveVoiceChanged });

    hook.syncActiveId("v-resolved");

    expect(hook.activeId.value).toBe("v-resolved");
    expect(calls).toHaveLength(0);
    expect(onActiveVoiceChanged).not.toHaveBeenCalled();
  });

  it("activateVoiceLocally updates the active id AND notifies the caller, without fetching", () => {
    stub(async () => {
      throw new Error("activateVoiceLocally must not touch the network");
    });
    const onActiveVoiceChanged = vi.fn();
    const hook = createUseVoices({ token: "t", initialActiveId: "default", onActiveVoiceChanged });

    hook.activateVoiceLocally("v-fish-cloned");

    expect(hook.activeId.value).toBe("v-fish-cloned");
    expect(calls).toHaveLength(0);
    expect(onActiveVoiceChanged).toHaveBeenCalledWith("v-fish-cloned");
  });
});
