import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { reset } from "@logtape/logtape";
import { createGatewayLogger } from "../logging/logger.js";
import {
  type AttachmentParserTransport,
  type ParserExecHandle,
  createAttachmentParserClient,
  validateAttachmentParserMetadata,
} from "./parser-client.js";

const tempDirs: string[] = [];
const tempFiles: string[] = [];
const logLines: string[] = [];
beforeAll(async () => {
  await createGatewayLogger({ testSink: (line) => logLines.push(line) });
});
afterAll(async () => {
  await reset();
});
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true });
  logLines.length = 0;
});

const OPTIONS = {
  containerName: "sentient-attachment-parser",
  maxInputBytes: 32,
  maxOutputBytes: 8,
  maxHeaderBytes: 8192,
  deadlineMs: 1_000,
  cleanupTimeoutMs: 100,
  maxEdge: 1600,
};

const ADDON_METADATA = {
  name: "attachment-parser",
  version: "0.2.0",
  protocolVersion: 2,
  description: "Bounded attachment decoding over Docker exec and an internal Unix socket.",
  state: "ephemeral",
} as const;

function frame(
  requestId: string,
  overrides: Partial<{
    version: number;
    requestId: string;
    status: number;
    contentType: string;
    contentLength: number;
    headers: Record<string, string>;
    error: string | null;
  }> = {},
  body = new Uint8Array(),
  trailing = new Uint8Array(),
): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      requestId,
      status: 200,
      contentType: "application/json",
      contentLength: body.byteLength,
      headers: {},
      error: null,
      ...overrides,
    }),
  );
  const output = new Uint8Array(4 + header.byteLength + body.byteLength + trailing.byteLength);
  new DataView(output.buffer).setUint32(0, header.byteLength);
  output.set(header, 4);
  output.set(body, 4 + header.byteLength);
  output.set(trailing, 4 + header.byteLength + body.byteLength);
  return output;
}

class SyntheticTransport implements AttachmentParserTransport {
  readonly calls: Array<{ argv: readonly string[]; input: number[]; destroyed: boolean }> = [];
  metadataCalls = 0;

  constructor(
    private readonly respond: (argv: readonly string[]) => Readable,
    private readonly exitCode: (argv: readonly string[]) => number = () => 0,
    private readonly metadata?: (requestId: string) => Readable,
  ) {}

  async start(_container: string, argv: readonly string[], attachStdin: boolean): Promise<ParserExecHandle> {
    if (argv[2] === "metadata") {
      this.metadataCalls++;
      const stdout =
        this.metadata?.(requestId(argv)) ??
        Readable.from([frame(requestId(argv), {}, new TextEncoder().encode(JSON.stringify(ADDON_METADATA)))]);
      return {
        stdin: undefined,
        stdout,
        inspect: async () => ({ Running: false, ExitCode: this.exitCode(argv) }),
        destroy: () => stdout.destroy(),
      };
    }
    const call = { argv, input: [] as number[], destroyed: false };
    this.calls.push(call);
    const stdin = attachStdin
      ? new Writable({
          write(chunk: Uint8Array, _encoding, done) {
            call.input.push(...chunk);
            done();
          },
        })
      : undefined;
    const stdout = this.respond(argv);
    return {
      stdin,
      stdout,
      inspect: async () => ({ Running: false, ExitCode: this.exitCode(argv) }),
      destroy: () => {
        call.destroyed = true;
        stdin?.destroy();
        stdout.destroy();
      },
    };
  }
}

class DelayedStartTransport implements AttachmentParserTransport {
  readonly handles: Array<{ argv: readonly string[]; destroyed: boolean }> = [];

  constructor(
    private readonly delayedCommands: readonly string[],
    private readonly delayMs: number,
    private readonly onStart?: (command: string) => void,
  ) {}

  async start(_container: string, argv: readonly string[], attachStdin: boolean): Promise<ParserExecHandle> {
    this.onStart?.(argv[2] ?? "");
    if (this.delayedCommands.includes(argv[2] ?? "")) await Bun.sleep(this.delayMs);
    const state = { argv, destroyed: false };
    const command = argv[2];
    const stdout =
      command === "metadata"
        ? Readable.from([frame(requestId(argv), {}, new TextEncoder().encode(JSON.stringify(ADDON_METADATA)))])
        : command === "cancel"
          ? Readable.from([frame(requestId(argv), { contentType: "application/octet-stream" })])
          : new Readable({ read() {} });
    const stdin = attachStdin
      ? new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        })
      : undefined;
    const handle: ParserExecHandle = {
      stdin,
      stdout,
      inspect: async () => ({ Running: false, ExitCode: 0 }),
      destroy: () => {
        state.destroyed = true;
        stdin?.destroy();
        stdout.destroy();
      },
    };
    this.handles.push(state);
    return handle;
  }
}

function bytes(...values: number[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Uint8Array.from(values);
    },
  };
}

function requestId(argv: readonly string[]): string {
  const value = argv[3];
  if (!value) throw new Error("synthetic request id missing");
  return value;
}

function request(signal?: AbortSignal) {
  return {
    mediaType: "image/png" as const,
    contentLength: 3,
    bytes: bytes(1, 2, 3),
    operation: { operation: "image-header" as const },
    ...(signal ? { signal } : {}),
  };
}

const FAKE_DOCKER = join(import.meta.dir, "test-fixtures/fake-docker");

// Bun 1.3.11's test runner prematurely EOFs Node child_process stdout while child remains running.
// Run adapter in standalone Bun process (production shape) and return only synthetic Result through temp file.
async function runCliProbe(dockerPath: string, containerName: string, deadlineMs = 1_000, cleanupTimeoutMs = 100) {
  const dir = mkdtempSync(join(tmpdir(), "parser-probe-"));
  tempDirs.push(dir);
  if (dockerPath === FAKE_DOCKER) {
    const callsPath = `/tmp/${containerName}.calls`;
    rmSync(callsPath, { force: true });
    tempFiles.push(callsPath);
  }
  const probe = join(dir, "probe.ts");
  const resultPath = join(dir, "result.json");
  writeFileSync(
    probe,
    `import { createAttachmentParserClient, createDockerCliAttachmentParserTransport } from ${JSON.stringify(join(import.meta.dir, "parser-client.ts"))};
const result = await createAttachmentParserClient(createDockerCliAttachmentParserTransport(${JSON.stringify(dockerPath)}), {
  containerName: ${JSON.stringify(containerName)}, maxInputBytes: 32, maxOutputBytes: 8, maxHeaderBytes: 8192,
  deadlineMs: ${deadlineMs}, cleanupTimeoutMs: ${cleanupTimeoutMs}, maxEdge: 1600,
}).parse({ mediaType: "image/png", contentLength: 3, bytes: (async function* () { yield Uint8Array.of(1, 2, 3); })(), operation: { operation: "image-header" } });
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
`,
  );
  const child = Bun.spawn([process.execPath, probe], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  return (await Bun.file(resultPath).json()) as unknown;
}

function pdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>",
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(new TextEncoder().encode(value).byteLength);
    value += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(value).byteLength;
  value += `xref\n0 4\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(value);
}

const REAL_CONTAINER = process.env.SENTIENT_PARSER_E2E_CONTAINER;
const REAL_CONTAINER_ID = process.env.SENTIENT_PARSER_E2E_CONTAINER_ID;
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function runRealCliProbe(containerName: string, containerId: string) {
  const dir = mkdtempSync(join(tmpdir(), "parser-real-probe-"));
  tempDirs.push(dir);
  const probe = join(dir, "probe.ts");
  const resultPath = join(dir, "result.json");
  const expectedIdentity = `${containerId}|/${containerName}|true|attachment-parser|true|none|true`;
  writeFileSync(
    probe,
    `import { createAttachmentParserClient, createDockerCliAttachmentParserTransport } from ${JSON.stringify(join(import.meta.dir, "parser-client.ts"))};
const docker = "/usr/local/bin/docker";
const containerName = ${JSON.stringify(containerName)};
const inspect = Bun.spawnSync([docker, "inspect", ${JSON.stringify(containerId)}, "--format", '{{.Id}}|{{.Name}}|{{index .Config.Labels "sentient.managed"}}|{{index .Config.Labels "sentient.service"}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}'], { stdout: "pipe", stderr: "ignore" });
const identity = inspect.stdout.toString().trim();
if (inspect.exitCode !== 0 || identity !== ${JSON.stringify(expectedIdentity)}) {
  await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ identity, identityExit: inspect.exitCode }));
  process.exit(2);
}
const client = createAttachmentParserClient(createDockerCliAttachmentParserTransport(docker), {
  containerName, maxInputBytes: 1_000_000, maxOutputBytes: 1_000_000, maxHeaderBytes: 8192,
  deadlineMs: 5_000, cleanupTimeoutMs: 1_000, maxEdge: 1600,
});
const png = Uint8Array.from(Buffer.from(${JSON.stringify(PNG_BASE64)}, "base64"));
const pdf = Uint8Array.from(Buffer.from(${JSON.stringify(Buffer.from(pdf()).toString("base64"))}, "base64"));
const pngResult = await client.parse({ mediaType: "image/png", contentLength: png.byteLength, bytes: (async function* () { yield png; })(), operation: { operation: "image-header" } });
const normalizeResult = await client.parse({
  mediaType: "image/png", contentLength: png.byteLength, bytes: (async function* () { yield png; })(),
  operation: { operation: "image-normalize", maxEdge: 8, region: { x: 0, y: 0, width: 1, height: 1 }, frameIndex: 0 },
});
const normalizeMetadata = normalizeResult.ok
  ? normalizeResult.value.headers["X-Sentient-Visual-Metadata"] ?? null
  : null;
const pdfResult = await client.parse({ mediaType: "application/pdf", contentLength: pdf.byteLength, bytes: (async function* () { yield pdf; })(), operation: { operation: "pdf-header" } });
const controller = new AbortController();
const cancelled = client.parse({
  mediaType: "image/png", contentLength: png.byteLength + 1,
  bytes: (async function* () { yield png; await new Promise(() => undefined); })(),
  operation: { operation: "image-header" }, signal: controller.signal,
});
await Bun.sleep(100);
controller.abort();
const cancelResult = await cancelled;
const cancelledRequestId = cancelResult.ok ? "" : cancelResult.error.requestId;
const postCancel = Bun.spawnSync([docker, "exec", containerName, "python3", "/app/exec_client.py", "cancel", cancelledRequestId], { stdout: "pipe", stderr: "ignore" });
const postCancelLength = postCancel.stdout.byteLength >= 4 ? postCancel.stdout.readUInt32BE(0) : -1;
const postCancelHeader = postCancelLength > 0 ? JSON.parse(postCancel.stdout.subarray(4, 4 + postCancelLength).toString()) : null;
const postCancelExactEof = postCancel.stdout.byteLength === 4 + postCancelLength;
const postCancelMatchesRequest = postCancelHeader?.requestId === cancelledRequestId;
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ identity, pngResult, normalizeResult, normalizeMetadata, pdfResult, cancelResult, postCancelExit: postCancel.exitCode, postCancelHeader, postCancelExactEof, postCancelMatchesRequest }));
`,
  );
  const child = Bun.spawn([process.execPath, probe], { stdout: "ignore", stderr: "ignore" });
  const exitCode = await child.exited;
  const result = (await Bun.file(resultPath).json()) as Record<string, unknown>;
  expect(exitCode).toBe(0);
  return result;
}

describe("attachment parser client", () => {
  it("streams exact input and returns a validated happy response", async () => {
    const body = Uint8Array.from([7, 8, 9]);
    const transport = new SyntheticTransport((argv) => Readable.from([frame(requestId(argv), {}, body)]));
    const result = await createAttachmentParserClient(transport, OPTIONS).parse(request());
    const requestCall = transport.calls.at(0);
    if (!requestCall) throw new Error("request exec missing");

    expect(result).toEqual({
      ok: true,
      value: {
        requestId: requestId(requestCall.argv),
        status: 200,
        contentType: "application/json",
        headers: {},
        body,
      },
    });
    expect(requestCall.argv).toEqual([
      "python3",
      "/app/exec_client.py",
      "request",
      requestId(requestCall.argv),
      "image-header",
      "image/png",
      "3",
      "--deadline-ms",
      "1000",
    ]);
    expect(requestCall.input).toEqual([1, 2, 3]);
  });

  it("accepts compatible metadata before consuming request bytes", async () => {
    const transport = new SyntheticTransport((argv) =>
      Readable.from([frame(requestId(argv), {}, Uint8Array.of(7, 8, 9))]),
    );
    const client = createAttachmentParserClient(transport, OPTIONS);
    const metadata = client.getMetadata;
    if (!metadata) throw new Error("metadata probe missing");
    expect(await metadata()).toEqual({ ok: true, value: ADDON_METADATA });
    const result = await client.parse(request());
    expect(result.ok).toBe(true);
    expect(transport.metadataCalls).toBe(2);
    expect(transport.calls).toHaveLength(1);
  });

  it("validates exact manifest shape and bounded SemVer", () => {
    for (const version of ["0.0.0", "1.2.3-alpha.1+build.5", `1.2.3+${"a".repeat(58)}`]) {
      expect(validateAttachmentParserMetadata({ ...ADDON_METADATA, version })).toEqual({
        ok: true,
        value: { ...ADDON_METADATA, version },
      });
    }
    for (const version of ["01.2.3", "1.2.3-", "1.2.3-01", "1.2.3+", `1.2.3+${"a".repeat(59)}`]) {
      expect(validateAttachmentParserMetadata({ ...ADDON_METADATA, version })).toMatchObject({
        ok: false,
        error: { code: "incompatible", reason: "version_malformed" },
      });
    }
    expect(validateAttachmentParserMetadata({ ...ADDON_METADATA, extra: true })).toEqual({
      ok: false,
      error: { code: "malformed", reason: "metadata_malformed" },
    });
  });

  it("rejects old, missing, and malformed metadata before request bytes", async () => {
    const cases: Array<{ body: Uint8Array; reason: string }> = [
      {
        body: new TextEncoder().encode(JSON.stringify({ ...ADDON_METADATA, version: "0.1.0", protocolVersion: 1 })),
        reason: "protocol_mismatch",
      },
      { body: new TextEncoder().encode("{}"), reason: "metadata_malformed" },
      { body: new TextEncoder().encode("not-json"), reason: "metadata_malformed" },
    ];
    for (const item of cases) {
      const transport = new SyntheticTransport(
        (argv) => Readable.from([frame(requestId(argv), {}, Uint8Array.of(7, 8, 9))]),
        () => 0,
        (id) => Readable.from([frame(id, {}, new Uint8Array(item.body))]),
      );
      const result = await createAttachmentParserClient(transport, OPTIONS).parse(request());
      expect(result).toMatchObject({ ok: false, error: { code: "incompatible", compatibilityReason: item.reason } });
      expect(transport.calls).toHaveLength(0);
    }
  });

  it("preserves metadata unavailable, timeout, and cancellation outcomes", async () => {
    const unavailable = new SyntheticTransport(
      () => Readable.from([]),
      () => 0,
      () => {
        throw new Error("metadata transport unavailable");
      },
    );
    const unavailableResult = await createAttachmentParserClient(unavailable, OPTIONS).parse(request());
    expect(unavailableResult).toMatchObject({ ok: false, error: { code: "unavailable" } });

    const timeoutTransport = new DelayedStartTransport(["metadata"], 30);
    const timeoutResult = await createAttachmentParserClient(timeoutTransport, { ...OPTIONS, deadlineMs: 10 }).parse(
      request(),
    );
    expect(timeoutResult).toMatchObject({ ok: false, error: { code: "timeout" } });
    await Bun.sleep(40);
    expect(timeoutTransport.handles.find(({ argv }) => argv[2] === "metadata")?.destroyed).toBe(true);

    const controller = new AbortController();
    const cancelledTransport = new DelayedStartTransport(["metadata"], 30);
    const cancelled = createAttachmentParserClient(cancelledTransport, OPTIONS).parse(request(controller.signal));
    await Bun.sleep(5);
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
    await Bun.sleep(40);
    expect(cancelledTransport.handles.find(({ argv }) => argv[2] === "metadata")?.destroyed).toBe(true);
  });

  it("cleans a handle when start aborts synchronously before abortable attaches", async () => {
    const controller = new AbortController();
    const transport = new DelayedStartTransport(["metadata"], 30, (command) => {
      if (command === "metadata") controller.abort();
    });
    const metadata = createAttachmentParserClient(transport, OPTIONS).getMetadata;
    if (!metadata) throw new Error("metadata probe missing");
    expect(await metadata(controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled", reason: "metadata_cancelled" },
    });
    await Bun.sleep(40);
    expect(transport.handles.find(({ argv }) => argv[2] === "metadata")?.destroyed).toBe(true);
  });

  it("cleans a cancel handle returned after cleanup timeout", async () => {
    const controller = new AbortController();
    const transport = new DelayedStartTransport(["cancel"], 30);
    const pending = createAttachmentParserClient(transport, { ...OPTIONS, cleanupTimeoutMs: 10 }).parse(
      request(controller.signal),
    );
    await Bun.sleep(5);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    await Bun.sleep(40);
    expect(transport.handles.find(({ argv }) => argv[2] === "cancel")?.destroyed).toBe(true);
    expect(transport.handles.find(({ argv }) => argv[2] === "request")?.destroyed).toBe(true);
  });

  it("cleans request handles returned after start timeout and cancellation", async () => {
    const timeoutTransport = new DelayedStartTransport(["request"], 30);
    const timeout = await createAttachmentParserClient(timeoutTransport, { ...OPTIONS, deadlineMs: 10 }).parse(
      request(),
    );
    expect(timeout).toMatchObject({ ok: false, error: { code: "timeout" } });
    await Bun.sleep(40);
    expect(timeoutTransport.handles.find(({ argv }) => argv[2] === "request")?.destroyed).toBe(true);

    const controller = new AbortController();
    const cancelledTransport = new DelayedStartTransport(["request"], 30);
    const cancelled = createAttachmentParserClient(cancelledTransport, OPTIONS).parse(request(controller.signal));
    await Bun.sleep(5);
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
    await Bun.sleep(40);
    expect(cancelledTransport.handles.find(({ argv }) => argv[2] === "request")?.destroyed).toBe(true);
  });

  it("bounds and cancels metadata probes", async () => {
    const oversized = new SyntheticTransport(
      () => Readable.from([]),
      () => 0,
      (id) => Readable.from([frame(id, { contentLength: 16 * 1024 + 1 }, new Uint8Array())]),
    );
    const oversizedClient = createAttachmentParserClient(oversized, OPTIONS);
    const oversizedProbe = oversizedClient.getMetadata;
    if (!oversizedProbe) throw new Error("metadata probe missing");
    expect(await oversizedProbe()).toEqual({
      ok: false,
      error: { code: "malformed", reason: "metadata_too_large" },
    });

    const controller = new AbortController();
    const hanging = new SyntheticTransport(
      () => Readable.from([]),
      () => 0,
      () => new Readable({ read() {} }),
    );
    const hangingClient = createAttachmentParserClient(hanging, OPTIONS);
    const hangingProbe = hangingClient.getMetadata;
    if (!hangingProbe) throw new Error("metadata probe missing");
    const pending = hangingProbe(controller.signal);
    await Bun.sleep(5);
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { code: "cancelled", reason: "metadata_cancelled" },
    });
  });

  it("bounds metadata bursts and removes disconnected waiters", async () => {
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const transport = new SyntheticTransport(
      () => Readable.from([]),
      () => 0,
      () => new Readable({ read() {} }),
    );
    const client = createAttachmentParserClient(transport, OPTIONS);
    const getMetadata = client.getMetadata;
    if (!getMetadata) throw new Error("metadata probe missing");
    const pending = controllers.map((controller) => getMetadata(controller.signal));

    await Bun.sleep(5);
    expect(transport.metadataCalls).toBe(1);
    expect(await pending[4]).toEqual({
      ok: false,
      error: { code: "unavailable", reason: "metadata_unavailable" },
    });

    for (const controller of controllers) controller.abort();
    expect(await Promise.all(pending.slice(0, 4))).toEqual([
      { ok: false, error: { code: "cancelled", reason: "metadata_cancelled" } },
      { ok: false, error: { code: "cancelled", reason: "metadata_cancelled" } },
      { ok: false, error: { code: "cancelled", reason: "metadata_cancelled" } },
      { ok: false, error: { code: "cancelled", reason: "metadata_cancelled" } },
    ]);
    expect(transport.metadataCalls).toBe(1);
  });

  it("rejects malformed framing with trailing bytes", async () => {
    const transport = new SyntheticTransport((argv) =>
      Readable.from([frame(requestId(argv), {}, new Uint8Array(), Uint8Array.of(1))]),
    );
    const result = await createAttachmentParserClient(transport, OPTIONS).parse(request());
    expect(result).toMatchObject({ ok: false, error: { code: "protocol_error", operation: "image-header" } });
  });

  it("rejects declared output over configured limit before reading body", async () => {
    const transport = new SyntheticTransport((argv) =>
      Readable.from([frame(requestId(argv), { contentLength: OPTIONS.maxOutputBytes + 1 })]),
    );
    const result = await createAttachmentParserClient(transport, OPTIONS).parse(request());
    expect(result).toMatchObject({ ok: false, error: { code: "output_too_large" } });
  });

  it("queues one decoder plus three waiters and recovers a cancelled queued slot", async () => {
    const outputs: PassThrough[] = [];
    const transport = new SyntheticTransport(() => {
      const output = new PassThrough();
      outputs.push(output);
      return output;
    });
    const client = createAttachmentParserClient(transport, OPTIONS);
    const queuedController = new AbortController();
    const pending = [
      client.parse(request()),
      client.parse(request(queuedController.signal)),
      client.parse(request()),
      client.parse(request()),
    ];
    await Bun.sleep(5);
    expect(transport.calls).toHaveLength(1);
    expect(await client.parse(request())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    queuedController.abort();
    expect(await pending[1]).toMatchObject({ ok: false, error: { code: "cancelled" } });
    for (let index = 0; index < 3; index++) {
      while (!transport.calls[index]) await Bun.sleep(1);
      const call = transport.calls[index];
      if (!call) throw new Error("queued parser call missing");
      outputs[index]?.end(frame(requestId(call.argv)));
      const result = pending[index === 0 ? 0 : index + 1];
      if (!result) throw new Error("queued parser result missing");
      expect((await result).ok).toBe(true);
    }
    expect(transport.calls).toHaveLength(3);
  });

  it("uses argv-only cancel exec and destroys request stream on abort", async () => {
    const controller = new AbortController();
    const transport = new SyntheticTransport((argv) => {
      if (argv[2] === "cancel")
        return Readable.from([frame(requestId(argv), { contentType: "application/octet-stream" })]);
      return new Readable({ read() {} });
    });
    const pending = createAttachmentParserClient(transport, OPTIONS).parse(request(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const requestCall = transport.calls.at(0);
    const cancelCall = transport.calls.at(1);
    if (!requestCall || !cancelCall) throw new Error("request or cancel exec missing");
    expect(cancelCall.argv).toEqual(["python3", "/app/exec_client.py", "cancel", requestId(requestCall.argv)]);
    expect(requestCall.destroyed).toBe(true);
    expect(logLines.filter((line) => line.includes("attachment_parser.failed"))).toEqual([]);
  });

  it("maps decoder timeout and infrastructure statuses without flattening decode errors", async () => {
    for (const [status, code] of [
      [408, "timeout"],
      [500, "unavailable"],
      [503, "unavailable"],
      [422, "parser_error"],
    ] as const) {
      const transport = new SyntheticTransport((argv) =>
        Readable.from([
          frame(requestId(argv), {
            status,
            contentType: "application/octet-stream",
            contentLength: 0,
            error: status === 408 ? "deadline_exceeded" : status >= 500 ? "parser_unavailable" : "decode_failed",
          }),
        ]),
      );
      expect(await createAttachmentParserClient(transport, OPTIONS).parse(request())).toMatchObject({
        ok: false,
        error: { code, status },
      });
    }
  });

  it("returns sanitized typed parser errors without response bytes", async () => {
    const transport = new SyntheticTransport(
      (argv) =>
        Readable.from([
          frame(requestId(argv), {
            status: 422,
            contentType: "application/octet-stream",
            contentLength: 0,
            error: "image_pixel_limit",
          }),
        ]),
      (argv) => (argv[2] === "metadata" ? 0 : 1),
    );
    const result = await createAttachmentParserClient(transport, OPTIONS).parse({
      ...request(),
      diagnosticContext: { attachmentId: "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sessionId: "session-1", entrySeq: 3 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "parser_error", operation: "image-header", status: 422, reason: "image_pixel_limit" },
    });
    expect(JSON.stringify(result)).not.toContain("1,2,3");
    const failure = logLines.find((line) => line.includes("attachment_parser.failed"));
    expect(failure).toContain(`requestId="${requestId(transport.calls[0]?.argv ?? [])}"`);
    expect(failure).toContain('operation="image-header"');
    expect(failure).toContain('reason="image_pixel_limit"');
    expect(failure).toContain('attachmentId="att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(failure).toContain('sessionId="session-1"');
    expect(failure).toContain("entrySeq=3");
    expect(failure).toContain("status=422");
    expect(failure).toContain("inputBytes=3");
    expect(failure).toContain("outputBytes=0");
  });

  it("keeps an already-cancelled invalid request quiet without changing validation", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new SyntheticTransport(() => Readable.from([]));
    const result = await createAttachmentParserClient(transport, OPTIONS).parse({
      ...request(controller.signal),
      contentLength: -1,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(transport.calls).toHaveLength(0);
    expect(logLines.some((line) => line.includes("attachment_parser.failed"))).toBe(false);
  });

  it("maps arbitrary parser reasons to unknown in diagnostics", async () => {
    const sentinel = "private_sentinel";
    const transport = new SyntheticTransport((argv) =>
      Readable.from([
        frame(requestId(argv), {
          status: 422,
          contentType: "application/octet-stream",
          contentLength: 0,
          error: sentinel,
        }),
      ]),
    );
    const result = await createAttachmentParserClient(transport, OPTIONS).parse(request());

    expect(result).toMatchObject({ ok: false, error: { code: "parser_error", reason: sentinel } });
    const failure = logLines.find((line) => line.includes("attachment_parser.failed"));
    expect(failure).toContain('reason="unknown"');
    expect(failure).not.toContain(sentinel);
  });

  it("uses Docker CLI status to classify metadata transport failures", async () => {
    const suffix = String(process.pid);
    expect(await runCliProbe(FAKE_DOCKER, `success-${suffix}`)).toMatchObject({
      ok: true,
      value: { status: 200 },
    });
    expect(await runCliProbe(FAKE_DOCKER, `missing-${suffix}`)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    const legacyContainer = `legacy-${suffix}`;
    expect(await runCliProbe(FAKE_DOCKER, legacyContainer)).toMatchObject({
      ok: false,
      error: { code: "incompatible", compatibilityReason: "metadata_unsupported" },
    });
    const legacyCalls = await Bun.file(`/tmp/${legacyContainer}.calls`).text();
    expect(legacyCalls).toContain(" metadata ");
    expect(legacyCalls).not.toContain(" request ");
    expect(await runCliProbe("/missing/sentient-docker", `spawn-missing-${suffix}`)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(await runCliProbe(FAKE_DOCKER, `excess-${suffix}`)).toMatchObject({
      ok: false,
      error: { code: "output_too_large" },
    });

    const hangContainer = `hang-${suffix}`;
    const callsPath = `/tmp/${hangContainer}.calls`;
    // Use the supported 100ms cleanup floor; 20ms can kill the cancel CLI before it starts.
    expect(await runCliProbe(FAKE_DOCKER, hangContainer, 30)).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    const calls = await Bun.file(callsPath).text();
    expect(calls).toContain(`exec ${hangContainer} python3 /app/exec_client.py metadata `);
  });

  it.skipIf(!REAL_CONTAINER || !REAL_CONTAINER_ID)(
    "parses PNG and PDF, forwards visual metadata, and cancels through real Docker CLI",
    async () => {
      if (!REAL_CONTAINER || !REAL_CONTAINER_ID) throw new Error("real parser fixture identity missing");
      const result = await runRealCliProbe(REAL_CONTAINER, REAL_CONTAINER_ID);
      expect(result.identity).toBe(`${REAL_CONTAINER_ID}|/${REAL_CONTAINER}|true|attachment-parser|true|none|true`);
      expect(result.pngResult).toMatchObject({ ok: true, value: { status: 200 } });
      expect(result.normalizeResult).toMatchObject({ ok: true, value: { status: 200, contentType: "image/png" } });
      expect(result.normalizeMetadata).toBeString();
      expect(JSON.parse(result.normalizeMetadata as string)).toMatchObject({
        source: { mediaType: "image/png", sizeBytes: 68 },
        view: {
          kind: "crop",
          sourceWidth: 1,
          sourceHeight: 1,
          region: { x: 0, y: 0, width: 1, height: 1 },
          frameIndex: 0,
        },
      });
      expect(result.pdfResult).toMatchObject({ ok: true, value: { status: 200 } });
      expect(result.cancelResult).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(result).toMatchObject({
        postCancelExit: 0,
        postCancelExactEof: true,
        postCancelMatchesRequest: true,
        postCancelHeader: { status: 404, error: "request_not_running" },
      });
    },
  );
});
