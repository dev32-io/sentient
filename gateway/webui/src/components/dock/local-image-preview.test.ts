import { imageSize } from "image-size";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareLocalImagePreview } from "./local-image-preview.ts";

type BitmapStub = Pick<ImageBitmap, "width" | "height" | "close">;

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    2,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
  ]);
}

function box(name: string, ...contents: Uint8Array[]): Uint8Array {
  const size = 8 + contents.reduce((total, content) => total + content.length, 0);
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(new TextEncoder().encode(name), 4);
  let offset = 8;
  for (const content of contents) {
    bytes.set(content, offset);
    offset += content.length;
  }
  return bytes;
}

function heifHeader(...dimensions: Array<readonly [number, number]>): Uint8Array {
  const ispe = dimensions.map(([width, height]) => {
    const values = new Uint8Array(12);
    const view = new DataView(values.buffer);
    view.setUint32(4, width);
    view.setUint32(8, height);
    return box("ispe", values);
  });
  const ftyp = box("ftyp", new TextEncoder().encode("heic\0\0\0\0"));
  const meta = box("meta", new Uint8Array(4), box("iprp", box("ipco", ...ispe)));
  const bytes = new Uint8Array(ftyp.length + meta.length);
  bytes.set(ftyp);
  bytes.set(meta, ftyp.length);
  return bytes;
}

function imageFile(bytes = pngHeader(10, 10), name = "fixture.png"): File {
  const contents = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = new File([contents], name, { type: name.endsWith(".png") ? "image/png" : "image/jpeg" });
  Object.defineProperties(file, {
    arrayBuffer: { configurable: true, value: async () => bytes.slice().buffer },
    slice: {
      configurable: true,
      value: (start = 0, end = bytes.length) => ({
        arrayBuffer: async () => bytes.slice(start, Math.min(end, bytes.length)).buffer,
      }),
    },
  });
  return file;
}

function installCanvas(output = new Blob(["poster"], { type: "image/webp" })) {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(output);
  });
  return { drawImage, output };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local image preview preparation", () => {
  it("creates a bounded static poster from the original and closes the decoded bitmap", async () => {
    const close = vi.fn();
    const bitmap: BitmapStub = { width: 1500, height: 3000, close };
    const create = vi.fn(async () => bitmap as ImageBitmap);
    vi.stubGlobal("createImageBitmap", create);
    const { drawImage, output } = installCanvas();
    const source = imageFile(pngHeader(3000, 1500), "portrait.png");

    const poster = await prepareLocalImagePreview(source, new AbortController().signal);

    expect(poster).toBe(output);
    expect(poster).not.toBe(source);
    expect(create).toHaveBeenCalledWith(source, { imageOrientation: "from-image" });
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 320, 640);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["48 MP PNG", pngHeader(8000, 6000), "large.png"],
    ["200 MP JPEG", jpegHeader(20_000, 10_000), "large.jpg"],
  ])("refuses a tiny %s header without decoding or reading the full original", async (_label, header, name) => {
    const create = vi.fn();
    vi.stubGlobal("createImageBitmap", create);
    const source = imageFile(header, name);
    Object.defineProperty(source, "size", { value: 11 * 1024 * 1024 });
    const slice = vi.spyOn(source, "slice");
    const fullRead = vi.spyOn(source, "arrayBuffer");

    await expect(prepareLocalImagePreview(source, new AbortController().signal)).resolves.toBeNull();

    expect(slice).toHaveBeenCalledWith(0, 64 * 1024);
    expect(fullRead).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "HEIF with a small first image and larger second image",
      heifHeader([1, 1], [20_000, 20_000]),
      "compound.heic",
      "heic",
    ],
    ["GIF logical canvas", Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]), "animated.gif", "gif"],
    [
      "TIFF first IFD",
      Uint8Array.from([
        73, 73, 42, 0, 8, 0, 0, 0, 2, 0, 0, 1, 4, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 4, 0, 1, 0, 0, 0, 1, 0, 0, 0,
      ]),
      "multipage.tiff",
      "tiff",
    ],
    ["SVG mislabeled as PNG", new TextEncoder().encode('<svg width="1" height="1"></svg>'), "mislabeled.png", "svg"],
  ])("leaves ambiguous %s originals untouched and does not decode them", async (_label, header, name, detectedType) => {
    const create = vi.fn();
    vi.stubGlobal("createImageBitmap", create);
    const source = imageFile(header, name);
    const fullRead = vi.spyOn(source, "arrayBuffer");

    expect(imageSize(header).type).toBe(detectedType);
    await expect(prepareLocalImagePreview(source, new AbortController().signal)).resolves.toBeNull();

    expect(source.name).toBe(name);
    expect(source.size).toBe(header.byteLength);
    expect(fullRead).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to the filename placeholder when dimensions are unavailable", async () => {
    const create = vi.fn();
    vi.stubGlobal("createImageBitmap", create);
    const source = imageFile(new TextEncoder().encode("not an image"), "unknown.heic");

    await expect(prepareLocalImagePreview(source, new AbortController().signal)).resolves.toBeNull();

    expect(source.name).toBe("unknown.heic");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not inspect or decode originals above the encoded-byte gate", async () => {
    const create = vi.fn();
    vi.stubGlobal("createImageBitmap", create);
    const source = imageFile();
    Object.defineProperty(source, "size", { value: 16 * 1024 * 1024 + 1 });
    const slice = vi.spyOn(source, "slice");

    await expect(prepareLocalImagePreview(source, new AbortController().signal)).resolves.toBeNull();
    expect(slice).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("limits preparation to two decodes and rejects already-aborted work before queueing", async () => {
    installCanvas();
    const releases: Array<(bitmap: ImageBitmap) => void> = [];
    const create = vi.fn(() => new Promise<ImageBitmap>((resolve) => releases.push(resolve)));
    vi.stubGlobal("createImageBitmap", create);
    const source = imageFile();
    const first = prepareLocalImagePreview(source, new AbortController().signal);
    const second = prepareLocalImagePreview(source, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(2);

    const aborted = new AbortController();
    aborted.abort();
    const abortedSource = imageFile();
    const slice = vi.spyOn(abortedSource, "slice");
    await expect(prepareLocalImagePreview(abortedSource, aborted.signal)).rejects.toBeDefined();
    expect(slice).not.toHaveBeenCalled();

    const fourth = prepareLocalImagePreview(source, new AbortController().signal);
    expect(create).toHaveBeenCalledTimes(2);
    releases.shift()?.({ width: 10, height: 10, close: vi.fn() } as unknown as ImageBitmap);
    await first;
    expect(create).toHaveBeenCalledTimes(3);
    for (const release of releases) release({ width: 10, height: 10, close: vi.fn() } as unknown as ImageBitmap);
    await Promise.all([second, fourth]);
  });

  it("closes a completed decode after cancellation without producing a poster", async () => {
    let release!: (bitmap: ImageBitmap) => void;
    const create = vi.fn(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("createImageBitmap", create);
    const controller = new AbortController();
    const close = vi.fn();
    const preparation = prepareLocalImagePreview(imageFile(), controller.signal);
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();
    release({ width: 10, height: 10, close } as unknown as ImageBitmap);

    await expect(preparation).rejects.toBeDefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
