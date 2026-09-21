import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTiffSource } from "./source-classifier.js";

const roots: string[] = [];

function write16(bytes: Buffer, endian: "LE" | "BE", value: number, offset: number): void {
  if (endian === "LE") bytes.writeUInt16LE(value, offset);
  else bytes.writeUInt16BE(value, offset);
}

function write32(bytes: Buffer, endian: "LE" | "BE", value: number, offset: number): void {
  if (endian === "LE") bytes.writeUInt32LE(value, offset);
  else bytes.writeUInt32BE(value, offset);
}

function write64(bytes: Buffer, endian: "LE" | "BE", value: bigint, offset: number): void {
  if (endian === "LE") bytes.writeBigUInt64LE(value, offset);
  else bytes.writeBigUInt64BE(value, offset);
}

function classic(endian: "LE" | "BE", tags: number[]): Buffer {
  const entryCount = tags.length;
  const bytes = Buffer.alloc(8 + 2 + entryCount * 12 + 4);
  bytes.write(endian === "LE" ? "II" : "MM", 0);
  write16(bytes, endian, 42, 2);
  write32(bytes, endian, 8, 4);
  write16(bytes, endian, entryCount, 8);
  tags.forEach((tag, index) => {
    const offset = 10 + index * 12;
    write16(bytes, endian, tag, offset);
    write16(bytes, endian, 4, offset + 2);
    write32(bytes, endian, 1, offset + 4);
    write32(bytes, endian, 1, offset + 8);
  });
  return bytes;
}

function bigTiff(endian: "LE" | "BE"): Buffer {
  const bytes = Buffer.alloc(52);
  bytes.write(endian === "LE" ? "II" : "MM", 0);
  write16(bytes, endian, 43, 2);
  write16(bytes, endian, 8, 4);
  write64(bytes, endian, 16n, 8);
  write64(bytes, endian, 1n, 16);
  write16(bytes, endian, 256, 24);
  write16(bytes, endian, 4, 26);
  write64(bytes, endian, 1n, 28);
  write64(bytes, endian, 1n, 36);
  return bytes;
}

function chainedIfds(count: number): Buffer {
  const bytes = Buffer.alloc(8 + count * 18);
  bytes.write("II", 0);
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * 18;
    bytes.writeUInt16LE(1, offset);
    bytes.writeUInt16LE(index === count - 1 ? 50706 : 256, offset + 2);
    bytes.writeUInt16LE(4, offset + 4);
    bytes.writeUInt32LE(1, offset + 6);
    bytes.writeUInt32LE(1, offset + 10);
    bytes.writeUInt32LE(index + 1 < count ? offset + 18 : 0, offset + 14);
  }
  return bytes;
}

function zeroThenRawSubIfd(): Buffer {
  const bytes = Buffer.alloc(52);
  bytes.write("II", 0);
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(330, 10);
  bytes.writeUInt16LE(4, 12);
  bytes.writeUInt32LE(2, 14);
  bytes.writeUInt32LE(26, 18);
  bytes.writeUInt32LE(0, 26);
  bytes.writeUInt32LE(34, 30);
  bytes.writeUInt16LE(1, 34);
  bytes.writeUInt16LE(50706, 36);
  bytes.writeUInt16LE(4, 38);
  bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(1, 44);
  return bytes;
}

async function classify(bytes: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "tiff-classifier-"));
  roots.push(root);
  const path = join(root, "source.tiff");
  await writeFile(path, bytes);
  return classifyTiffSource(path);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TIFF source classifier", () => {
  it("accepts ordinary classic and BigTIFF in both byte orders without looping on cycles", async () => {
    for (const bytes of [classic("LE", [256]), classic("BE", [256]), bigTiff("LE"), bigTiff("BE")])
      expect(await classify(bytes)).toBe("supported");
    const cycle = classic("LE", [256]);
    cycle.writeUInt32LE(8, 22);
    expect(await classify(cycle)).toBe("supported");
  });

  it("finds RAW beyond old traversal limits and past zero SubIFD pointers", async () => {
    expect(await classify(chainedIfds(17))).toBe("raw");
    expect(await classify(classic("LE", [...Array(512).fill(256), 50706]))).toBe("raw");
    expect(await classify(zeroThenRawSubIfd())).toBe("raw");
  });

  it("recognizes standard RAW photometric and Nikon compression values", async () => {
    const photometric = classic("LE", [262]);
    photometric.writeUInt32LE(32803, 18);
    const nikon = classic("LE", [259]);
    nikon.writeUInt32LE(34713, 18);
    expect(await classify(photometric)).toBe("raw");
    expect(await classify(nikon)).toBe("raw");
  });

  it("fails closed on malformed and exhausted metadata", async () => {
    expect(await classify(Buffer.from("49492a0008000000", "hex"))).toBe("unresolved");
    const tooManyEntries = Buffer.alloc(10);
    tooManyEntries.write("II", 0);
    tooManyEntries.writeUInt16LE(42, 2);
    tooManyEntries.writeUInt32LE(8, 4);
    tooManyEntries.writeUInt16LE(8_193, 8);
    expect(await classify(tooManyEntries)).toBe("unresolved");

    const hugeChildren = zeroThenRawSubIfd();
    hugeChildren.writeUInt32LE(257, 14);
    expect(await classify(hugeChildren)).toBe("unresolved");
  });
});
