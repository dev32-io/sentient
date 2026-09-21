import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttachmentCapability,
  type AttachmentUpload,
  consumeAttachmentCleanupIntents,
  createAttachmentStorage,
  mintAttachmentId,
  sanitizeAttachmentName,
} from "./storage.js";

const roots: string[] = [];
const limits = {
  maxFileBytes: 64,
  maxFilesPerAttempt: 8,
  maxRequestBytes: 256,
  maxUserBytes: 512,
  stagingTtlMs: 1_000,
};

async function harness(ownerUserId = "u_test", overrides: Partial<typeof limits> = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "attachment-store-"));
  roots.push(rootPath);
  const cap: AttachmentCapability = { ownerUserId, resource: "attachment-store", rootPath };
  return { rootPath, store: createAttachmentStorage(cap, { ...limits, ...overrides }) };
}

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* values;
}

function upload(bytes: Uint8Array, overrides: Partial<AttachmentUpload> = {}): AttachmentUpload {
  return {
    attachmentId: mintAttachmentId(),
    fileIdentity: "file-1",
    displayName: "../synthetic.txt",
    contentType: "text/plain",
    bytes: chunks(bytes),
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

function only<T>(values: readonly T[]): T {
  if (values.length !== 1) throw new Error(`expected one value, got ${values.length}`);
  return values[0] as T;
}

function littleEndianTiff(tag: number, cr2 = false): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write("II", 0);
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(12, 4);
  if (cr2) Buffer.from([0x43, 0x52, 0x02, 0x00]).copy(bytes, 8);
  bytes.writeUInt16LE(1, 12);
  bytes.writeUInt16LE(tag, 14);
  bytes.writeUInt16LE(4, 16);
  bytes.writeUInt32LE(1, 18);
  bytes.writeUInt32LE(1, 22);
  return bytes;
}

function ordinaryTiff(big: boolean, little: boolean): Uint8Array {
  const bytes = Buffer.alloc(big ? 52 : 26);
  bytes.write(little ? "II" : "MM", 0);
  const u16 = little ? bytes.writeUInt16LE.bind(bytes) : bytes.writeUInt16BE.bind(bytes);
  const u32 = little ? bytes.writeUInt32LE.bind(bytes) : bytes.writeUInt32BE.bind(bytes);
  const u64 = little ? bytes.writeBigUInt64LE.bind(bytes) : bytes.writeBigUInt64BE.bind(bytes);
  u16(big ? 43 : 42, 2);
  if (big) {
    u16(8, 4);
    u64(16n, 8);
    u64(1n, 16);
    u16(256, 24);
    u16(4, 26);
    u64(1n, 28);
    u64(1n, 36);
  } else {
    u32(8, 4);
    u16(1, 8);
    u16(256, 10);
    u16(4, 12);
    u32(1, 14);
    u32(1, 18);
  }
  return bytes;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("attachment name sanitization", () => {
  it("falls back for empty and reserved basenames", () => {
    for (const name of ["", " ", ".", "..", "/tmp/.", "/tmp/.."]) {
      expect(sanitizeAttachmentName(name)).toBe("attachment");
    }
  });

  it("keeps canonical basenames and their extensions", () => {
    expect(sanitizeAttachmentName("../photo.jpg")).toBe("photo.jpg");
    expect(sanitizeAttachmentName("..\\photo.jpg")).toBe("photo.jpg");
    expect(sanitizeAttachmentName("report.pdf")).toBe("report.pdf");
  });
});

describe("attachment storage", () => {
  it("stages retry-stable identities, validates allowed bytes, and exposes only published originals", async () => {
    const { store } = await harness();
    const text = new TextEncoder().encode("synthetic fixture\n");
    const id = mintAttachmentId();
    const first = only(await store.stageAttempt("attempt-1", [upload(text, { attachmentId: id })]));
    const retry = only(await store.stageAttempt("attempt-1", [upload(text, { attachmentId: id })]));

    expect(retry).toMatchObject({
      attachmentId: id,
      sha256: first.sha256,
      size: text.length,
      displayName: "synthetic.txt",
    });
    await expect(collect(store.read({ ...first, status: "durable", sessionId: "session-1" }))).rejects.toMatchObject({
      code: "not_found",
    });

    const durable = await store.publishCommitted(first, "session-1");
    expect(await collect(store.read(durable))).toEqual(text);
    await expect(
      store.stageAttempt("attempt-1", [upload(new TextEncoder().encode("changed"), { attachmentId: id })]),
    ).rejects.toMatchObject({
      code: "identity_conflict",
    });

    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pdf = new TextEncoder().encode("%PDF-1.7\n");
    const heic = new TextEncoder().encode("0000ftypheic");
    await store.stageAttempt("attempt-types", [
      upload(Uint8Array.from([0xff, 0xd8, 0xff]), {
        attachmentId: mintAttachmentId(),
        fileIdentity: "jpeg",
        contentType: "image/jpeg",
      }),
      upload(png, { attachmentId: mintAttachmentId(), fileIdentity: "png", contentType: "image/png" }),
      upload(pdf, { attachmentId: mintAttachmentId(), fileIdentity: "pdf", contentType: "application/pdf" }),
      upload(heic, { attachmentId: mintAttachmentId(), fileIdentity: "heic", contentType: "image/heic" }),
    ]);
    await expect(
      store.stageAttempt("attempt-bad", [upload(Uint8Array.from([0xff]), { contentType: "text/plain" })]),
    ).rejects.toMatchObject({ code: "unsupported_type" });
  });

  it("fails closed for RAW or unresolved TIFF and preserves ordinary classic/BigTIFF bytes", async () => {
    const { store } = await harness();
    for (const [name, bytes] of [
      ["renamed.dng.tiff", littleEndianTiff(50706)],
      ["renamed.cr2.tiff", littleEndianTiff(256, true)],
      ["renamed.nef.tiff", littleEndianTiff(41730)],
      ["truncated.tiff", Buffer.from("49492a0008000000", "hex")],
    ] as const) {
      await expect(
        store.stageAttempt(name, [upload(bytes, { contentType: "image/tiff", displayName: name })]),
      ).rejects.toMatchObject({ code: "unsupported_type" });
    }

    for (const [index, bytes] of [
      ordinaryTiff(false, true),
      ordinaryTiff(false, false),
      ordinaryTiff(true, true),
      ordinaryTiff(true, false),
    ].entries()) {
      const staged = only(
        await store.stageAttempt(`ordinary-${index}`, [
          upload(bytes, {
            attachmentId: mintAttachmentId(),
            fileIdentity: `ordinary-${index}`,
            contentType: "image/tiff",
          }),
        ]),
      );
      expect(staged.mediaKind).toBe("image");
      expect(await collect(store.read(await store.publishCommitted(staged, `session-${index}`)))).toEqual(bytes);
    }
  });

  it("enforces streaming file, request, count, and user budgets", async () => {
    const tooLarge = await harness("u_file", { maxFileBytes: 3 });
    await expect(
      tooLarge.store.stageAttempt("attempt", [upload(new TextEncoder().encode("four"))]),
    ).rejects.toMatchObject({
      code: "file_too_large",
    });

    const request = await harness("u_request", { maxRequestBytes: 5 });
    await expect(
      request.store.stageAttempt("attempt", [
        upload(new TextEncoder().encode("abc")),
        upload(new TextEncoder().encode("def"), { attachmentId: mintAttachmentId(), fileIdentity: "file-2" }),
      ]),
    ).rejects.toMatchObject({ code: "request_too_large" });

    const quota = await harness("u_quota", { maxUserBytes: 3 });
    await expect(quota.store.stageAttempt("attempt", [upload(new TextEncoder().encode("four"))])).rejects.toMatchObject(
      {
        code: "quota_exceeded",
      },
    );
    await expect(request.store.stageAttempt("attempt", [])).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses traversal, foreign handles, and symlinked storage", async () => {
    const { rootPath, store } = await harness();
    await expect(
      store.stageAttempt("attempt", [upload(new Uint8Array(), { attachmentId: "../escape" })]),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });

    const staged = only(await store.stageAttempt("attempt", [upload(new TextEncoder().encode("safe"))]));
    const durable = await store.publishCommitted(staged, "session");
    await expect(collect(store.read({ ...durable, ownerUserId: "u_foreign" }))).rejects.toMatchObject({
      code: "foreign",
    });

    const [sessionDir] = await readdir(join(rootPath, "attachments", "sessions"));
    if (!sessionDir) throw new Error("missing session directory");
    const outsideSession = await mkdtemp(join(tmpdir(), "attachment-session-outside-"));
    roots.push(outsideSession);
    await writeFile(join(outsideSession, durable.attachmentId), "do not delete");
    await rm(join(rootPath, "attachments", "sessions", sessionDir), { recursive: true });
    await symlink(outsideSession, join(rootPath, "attachments", "sessions", sessionDir));
    await expect(store.deleteDurable(durable)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readdir(outsideSession)).toEqual([durable.attachmentId]);

    await rm(join(rootPath, "attachments"), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "attachment-outside-"));
    roots.push(outside);
    await symlink(outside, join(rootPath, "attachments"));
    await expect(store.stageAttempt("attempt-2", [upload(new TextEncoder().encode("blocked"))])).rejects.toMatchObject({
      code: "unsafe_path",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("keeps publication atomic and removes temp files after failed streams", async () => {
    const { rootPath, store } = await harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const id = mintAttachmentId();
    async function* gated() {
      yield new TextEncoder().encode("half");
      await gate;
      yield new TextEncoder().encode(" done");
    }
    const pending = store.stageAttempt("attempt", [upload(new Uint8Array(), { attachmentId: id, bytes: gated() })]);
    while (true) {
      const names = await readdir(join(rootPath, "attachments", "staging")).catch(() => []);
      if (names.some((name) => name.startsWith(".tmp-"))) {
        expect(names).not.toContain(id);
        break;
      }
      await Bun.sleep(1);
    }
    release();
    await pending;
    expect(await readdir(join(rootPath, "attachments", "staging"))).toEqual([id]);

    async function* fails() {
      yield new TextEncoder().encode("partial");
      throw new Error("synthetic write failure");
    }
    await expect(store.stageAttempt("attempt-2", [upload(new Uint8Array(), { bytes: fails() })])).rejects.toThrow(
      "synthetic write failure",
    );
    expect(
      (await readdir(join(rootPath, "attachments", "staging"))).filter((name) => name.startsWith(".tmp-")),
    ).toEqual([]);
  });

  it("expires abandoned staging and consumes durable session cleanup intents only after unlink", async () => {
    const { rootPath, store } = await harness();
    const keep = only(await store.stageAttempt("attempt", [upload(new TextEncoder().encode("keep"))]));
    const expire = only(
      await store.stageAttempt("attempt", [upload(new TextEncoder().encode("expire"), { fileIdentity: "file-2" })]),
    );
    const old = new Date(Date.now() - 2_000);
    await utimes(join(rootPath, "attachments", "staging", keep.attachmentId), old, old);
    await utimes(join(rootPath, "attachments", "staging", expire.attachmentId), old, old);
    expect(await store.expireStaging(new Set([keep.attachmentId]))).toEqual({ expired: 1, refused: 0 });

    const durable = await store.publishCommitted(keep, "session-cleanup");
    const pending = [{ sessionId: "session-cleanup" }];
    const source = {
      listFileCleanupIntents: () => pending,
      ackFileCleanupIntent: (sessionId: string) => {
        const index = pending.findIndex((intent) => intent.sessionId === sessionId);
        if (index < 0) return false;
        pending.splice(index, 1);
        return true;
      },
    };
    expect(await consumeAttachmentCleanupIntents(source, store, 10)).toEqual({ cleaned: 1, failed: 0 });
    await expect(collect(store.read(durable))).rejects.toMatchObject({ code: "not_found" });
    expect(pending).toEqual([]);
  });
});
