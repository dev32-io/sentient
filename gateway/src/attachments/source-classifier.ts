import { open } from "node:fs/promises";

const MAX_IFDS = 256;
const MAX_ENTRIES = 8_192;
const MAX_READ_BYTES = 1024 * 1024;
const RAW_TIFF_TAGS = new Set([33421, 33422, 41730, 50706]); // CFA layout/pattern or DNG version
const TYPE_SIZES = new Map([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [6, 1],
  [7, 1],
  [8, 2],
  [9, 4],
  [10, 8],
  [11, 4],
  [12, 8],
  [13, 4],
  [16, 8],
  [17, 8],
  [18, 8],
]);

export type TiffSourceClassification = "supported" | "raw" | "unresolved";

class UnresolvedTiff extends Error {}

/**
 * Classifies classic TIFF and BigTIFF by walking next-IFD and SubIFD links.
 * Bounds are aggregate: 256 IFDs, 8,192 entries, and 1 MiB read. Unknown RAW
 * schemes can remain supported; malformed or budget-exhausted metadata cannot.
 */
export async function classifyTiffSource(path: string): Promise<TiffSourceClassification> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    let bytesRead = 0;
    const read = async (length: number, position: number): Promise<Buffer> => {
      if (
        !Number.isSafeInteger(position) ||
        !Number.isSafeInteger(length) ||
        position < 0 ||
        length < 0 ||
        position + length > size ||
        bytesRead + length > MAX_READ_BYTES
      )
        throw new UnresolvedTiff();
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, position);
      if (result.bytesRead !== length) throw new UnresolvedTiff();
      bytesRead += length;
      return buffer;
    };

    try {
      const first = await read(8, 0);
      const little = first.subarray(0, 2).equals(Buffer.from("II"));
      if (!little && !first.subarray(0, 2).equals(Buffer.from("MM"))) throw new UnresolvedTiff();
      const uint16 = (value: Buffer, offset = 0) => (little ? value.readUInt16LE(offset) : value.readUInt16BE(offset));
      const uint32 = (value: Buffer, offset = 0) => (little ? value.readUInt32LE(offset) : value.readUInt32BE(offset));
      const uint64 = (value: Buffer, offset = 0) => {
        const result = little ? value.readBigUInt64LE(offset) : value.readBigUInt64BE(offset);
        if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new UnresolvedTiff();
        return Number(result);
      };
      const magic = uint16(first, 2);
      let big: boolean;
      let firstIfd: number;
      if (magic === 42) {
        big = false;
        firstIfd = uint32(first, 4);
        if (size >= 12 && (await read(4, 8)).equals(Buffer.from([0x43, 0x52, 0x02, 0x00]))) return "raw";
      } else if (magic === 43) {
        const rest = await read(8, 8);
        if (uint16(first, 4) !== 8 || uint16(first, 6) !== 0) throw new UnresolvedTiff();
        big = true;
        firstIfd = uint64(rest);
      } else {
        throw new UnresolvedTiff();
      }
      if (firstIfd === 0) throw new UnresolvedTiff();

      const countSize = big ? 8 : 2;
      const entrySize = big ? 20 : 12;
      const inlineSize = big ? 8 : 4;
      const pending = [firstIfd];
      const visited = new Set<number>();
      let entriesSeen = 0;

      while (pending.length) {
        const offset = pending.shift() as number;
        if (offset === 0 || visited.has(offset)) continue;
        if (visited.size >= MAX_IFDS) throw new UnresolvedTiff();
        visited.add(offset);
        const countBuffer = await read(countSize, offset);
        const count = big ? uint64(countBuffer) : uint16(countBuffer);
        if (count > MAX_ENTRIES - entriesSeen) throw new UnresolvedTiff();
        const tableLength = count * entrySize + inlineSize;
        if (!Number.isSafeInteger(tableLength)) throw new UnresolvedTiff();
        const table = await read(tableLength, offset + countSize);
        entriesSeen += count;

        for (let index = 0; index < count; index++) {
          const entryOffset = index * entrySize;
          const entry = table.subarray(entryOffset, entryOffset + entrySize);
          const tag = uint16(entry);
          const type = uint16(entry, 2);
          const typeSize = TYPE_SIZES.get(type);
          if (!typeSize) throw new UnresolvedTiff();
          const itemCount = big ? uint64(entry, 4) : uint32(entry, 4);
          const valueLength = itemCount * typeSize;
          if (!Number.isSafeInteger(valueLength)) throw new UnresolvedTiff();
          const valueField = big ? 12 : 8;
          const valueOffset = big ? uint64(entry, valueField) : uint32(entry, valueField);
          if (valueLength > inlineSize && valueOffset + valueLength > size) throw new UnresolvedTiff();

          if (RAW_TIFF_TAGS.has(tag)) return "raw";
          if ((tag === 262 || tag === 259) && itemCount > 0 && [3, 4, 16].includes(type)) {
            const value =
              valueLength <= inlineSize
                ? entry.subarray(valueField, valueField + inlineSize)
                : await read(typeSize, valueOffset);
            const scalar = type === 3 ? uint16(value) : type === 4 ? uint32(value) : uint64(value);
            if ((tag === 262 && (scalar === 32803 || scalar === 34892)) || (tag === 259 && scalar === 34713))
              return "raw";
          }
          if (tag !== 330) continue;
          if (![4, 13, 16, 18].includes(type) || itemCount > MAX_IFDS) throw new UnresolvedTiff();
          const value =
            valueLength <= inlineSize
              ? entry.subarray(valueField, valueField + inlineSize)
              : await read(valueLength, valueOffset);
          for (let child = 0; child < itemCount; child++) {
            const childOffset = type === 4 || type === 13 ? uint32(value, child * 4) : uint64(value, child * 8);
            if (childOffset !== 0) pending.push(childOffset);
          }
        }
        const next = big ? uint64(table, count * entrySize) : uint32(table, count * entrySize);
        if (next !== 0) pending.push(next);
      }
      return "supported";
    } catch (error) {
      if (error instanceof UnresolvedTiff || error instanceof RangeError) return "unresolved";
      throw error;
    }
  } finally {
    await file.close();
  }
}
