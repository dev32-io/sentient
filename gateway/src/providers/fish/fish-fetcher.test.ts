import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFishVoiceById, fetchFishVoices } from "./fish-fetcher.js";

const sampleResponse = {
  items: [
    {
      _id: "v1",
      title: "Bright Friendly",
      description: "Cheerful female",
      languages: ["en"],
      tags: ["female", "warm"],
      cover_image: "https://f.example/cover.jpg",
      samples: [{ audio: "https://f.example/preview.mp3" }],
      visibility: "public",
      task_count: 1234,
      created_at: "2026-01-15T00:00:00Z",
    },
    {
      _id: "v2",
      title: "Stoic Narrator",
      description: "",
      languages: ["en", "ja"],
      tags: [],
      cover_image: null,
      samples: [],
      visibility: "public",
    },
  ],
};

const config = {
  apiKey: "fish-test-key",
  timeoutMs: 5_000,
};

// biome-ignore lint/suspicious/noExplicitAny: vitest fetch spy generic
let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe("fetchFishVoices", () => {
  it("normalizes Fish /model response into a VoicePage", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));

    const r = await fetchFishVoices(config);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.voices).toHaveLength(2);
    expect(r.value.hasMore).toBe(false); // 2 items < page size of 200
    const [v0, v1] = r.value.voices;
    if (!v0 || !v1) throw new Error("expected two voices");
    expect(v0.id).toBe("v1");
    expect(v0.title).toBe("Bright Friendly");
    expect(v0.description).toBe("Cheerful female");
    expect(v0.languages).toEqual(["en"]);
    expect(v0.tags).toEqual(["female", "warm"]);
    expect(v0.coverImageUrl).toBe("https://f.example/cover.jpg");
    expect(v0.previewAudioUrl).toBe("https://f.example/preview.mp3");
    expect(v0.visibility).toBe("public");
    expect(v0.taskCount).toBe(1234);
    expect(v0.createdAt).toBe("2026-01-15T00:00:00Z");
    expect(v1.id).toBe("v2");
    expect(v1.taskCount).toBe(0);
    expect(v1.createdAt).toBe("");
  });

  it("requests a 200-item page sorted by score against the default Fish base URL", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await fetchFishVoices(config);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fish.audio/model?page_size=200&sort_by=score",
      expect.objectContaining({ headers: { Authorization: "Bearer fish-test-key" } }),
    );
  });

  it("appends ?title= when title is set, URL-encoding spaces and specials", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await fetchFishVoices(config, { title: "iron man" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fish.audio/model?page_size=200&sort_by=score&title=iron+man",
      expect.objectContaining({ headers: { Authorization: "Bearer fish-test-key" } }),
    );
  });

  it("ignores blank title (no extra query param)", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await fetchFishVoices(config, { title: "   " });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fish.audio/model?page_size=200&sort_by=score",
      expect.anything(),
    );
  });

  it("appends ?page_number= when page > 1", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await fetchFishVoices(config, { page: 3 });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fish.audio/model?page_size=200&sort_by=score&page_number=3",
      expect.anything(),
    );
  });

  it("omits the Authorization header when apiKey is null", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await fetchFishVoices({ apiKey: null, timeoutMs: 5_000 });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fish.audio/model?page_size=200&sort_by=score",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("hasMore is true when the page is full (>= page_size items)", async () => {
    const fullItems = Array.from({ length: 200 }, (_, i) => ({
      _id: `v${i}`,
      title: `Voice ${i}`,
    }));
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items: fullItems }), { status: 200 }));

    const r = await fetchFishVoices(config);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hasMore).toBe(true);
  });

  it("falls back to null for missing coverImageUrl and previewAudioUrl", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));

    const r = await fetchFishVoices(config);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v1 = r.value.voices[1];
    if (!v1) throw new Error("expected second voice");
    expect(v1.coverImageUrl).toBeNull();
    expect(v1.previewAudioUrl).toBeNull();
  });

  it("returns fetch-error on non-2xx", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));

    const r = await fetchFishVoices(config);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("fetch-error");
    if (r.error.kind === "fetch-error") {
      expect(r.error.status).toBe(503);
    }
  });

  it("returns timeout when AbortSignal.timeout fires (DOMException 'TimeoutError')", async () => {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError"
    // per the WHATWG spec — NOT "AbortError". Pin the real shape.
    fetchSpy.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new DOMException("The operation timed out.", "TimeoutError")), 5);
        }),
    );

    const r = await fetchFishVoices({ ...config, timeoutMs: 50 });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("timeout");
    if (r.error.kind === "timeout") {
      expect(r.error.afterMs).toBe(50);
    }
  });

  it("returns parse-error on malformed JSON", async () => {
    fetchSpy.mockResolvedValue(new Response("{not-json", { status: 200 }));

    const r = await fetchFishVoices(config);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("parse-error");
  });
});

describe("fetchFishVoiceById", () => {
  const singleVoice = sampleResponse.items[0];

  it("fetches a single voice by id-encoded URL and maps it to a VoiceEntry", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(singleVoice), { status: 200 }));

    const r = await fetchFishVoiceById(config, "v1 special/id");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fish.audio/model/v1%20special%2Fid",
      expect.objectContaining({ headers: { Authorization: "Bearer fish-test-key" } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe("v1");
    expect(r.value.previewAudioUrl).toBe("https://f.example/preview.mp3");
  });

  it("returns not-found on a 404", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 404 }));

    const r = await fetchFishVoiceById(config, "missing");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("not-found");
  });

  it("returns fetch-error on other non-2xx statuses", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));

    const r = await fetchFishVoiceById(config, "v1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("fetch-error");
  });
});
