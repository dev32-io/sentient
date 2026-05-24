/**
 * Minimal EBML/WebM parser for extracting audio track info and SimpleBlock data.
 * No dependencies — pure TypeScript. Designed for parsing MediaRecorder WebM/Opus output.
 */

// EBML Element IDs we care about
const EBML_IDS = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  DocType: 0x4282,
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Block: 0xa1,
} as const;

// Reverse map for names
const ID_NAMES = new Map(Object.entries(EBML_IDS).map(([k, v]) => [v, k]));

export interface EBMLElement {
  id: number;
  name: string;
  size: number;
  offset: number;
  data?: Buffer;
  value?: string | number;
}

export interface WebMParseResult {
  elements: EBMLElement[];
  audioTrackFound: boolean;
  codecId: string | null;
  trackType: number | null;
  simpleBlocks: number;
  totalAudioBytes: number;
  errors: number;
}

// Read EBML variable-size integer (VINT)
function readVint(buf: Buffer, offset: number): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;

  // Count leading zeros to determine VINT length
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length++;
    mask >>= 1;
  }
  if (length > 8) return null;
  if (offset + length > buf.length) return null;

  let value = first & (mask - 1); // Remove VINT marker bit
  for (let i = 1; i < length; i++) {
    value = (value << 8) | buf[offset + i];
  }

  return { value, length };
}

// Read EBML Element ID (same encoding as VINT but marker bit stays)
function readElementId(buf: Buffer, offset: number): { id: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    length++;
    mask >>= 1;
  }
  if (length > 4) return null;
  if (offset + length > buf.length) return null;

  // ID includes the marker bit (unlike VINT size)
  let id = first;
  for (let i = 1; i < length; i++) {
    id = (id << 8) | buf[offset + i];
  }

  return { id, length };
}

// Check if an element is a master (container) element
function isMasterElement(id: number): boolean {
  return (
    id === EBML_IDS.EBML ||
    id === EBML_IDS.Segment ||
    id === EBML_IDS.Tracks ||
    id === EBML_IDS.TrackEntry ||
    id === EBML_IDS.Audio ||
    id === EBML_IDS.Cluster
  );
}

export function parseWebM(buf: Buffer): WebMParseResult {
  const result: WebMParseResult = {
    elements: [],
    audioTrackFound: false,
    codecId: null,
    trackType: null,
    simpleBlocks: 0,
    totalAudioBytes: 0,
    errors: 0,
  };

  let offset = 0;
  const maxDepth = 20;

  function parse(end: number, depth: number) {
    if (depth > maxDepth) return;

    while (offset < end && offset < buf.length) {
      const idResult = readElementId(buf, offset);
      if (!idResult) { result.errors++; break; }

      const sizeResult = readVint(buf, offset + idResult.length);
      if (!sizeResult) { result.errors++; break; }

      const headerSize = idResult.length + sizeResult.length;
      const elementSize = sizeResult.value;
      const name = ID_NAMES.get(idResult.id) || `0x${idResult.id.toString(16)}`;

      const el: EBMLElement = {
        id: idResult.id,
        name,
        size: elementSize,
        offset,
      };

      // Check for unknown size (all 1s in VINT data bits)
      const isUnknownSize =
        elementSize === (1 << (7 * sizeResult.length)) - 1;

      if (isMasterElement(idResult.id)) {
        result.elements.push(el);
        offset += headerSize;
        if (isUnknownSize) {
          // Unknown size — parse until end of buffer
          parse(buf.length, depth + 1);
        } else {
          parse(offset + elementSize, depth + 1);
        }
      } else {
        // Data element
        offset += headerSize;

        if (!isUnknownSize && offset + elementSize <= buf.length) {
          el.data = buf.slice(offset, offset + elementSize);

          // Parse known types
          if (idResult.id === EBML_IDS.DocType || idResult.id === EBML_IDS.CodecID) {
            el.value = el.data.toString("utf8");
            if (idResult.id === EBML_IDS.CodecID) {
              result.codecId = el.value;
            }
          } else if (idResult.id === EBML_IDS.TrackType) {
            el.value = el.data.length === 1 ? el.data[0] : 0;
            result.trackType = el.value as number;
            if (el.value === 2) result.audioTrackFound = true;
          } else if (idResult.id === EBML_IDS.EBMLVersion) {
            el.value = el.data.length === 1 ? el.data[0] : 0;
          } else if (idResult.id === EBML_IDS.SimpleBlock) {
            result.simpleBlocks++;
            result.totalAudioBytes += elementSize;
          } else if (idResult.id === EBML_IDS.Block) {
            result.simpleBlocks++;
            result.totalAudioBytes += elementSize;
          }

          result.elements.push(el);
          offset += elementSize;
        } else {
          // Unknown size or past buffer — skip to end
          result.elements.push(el);
          offset = buf.length;
        }
      }
    }
  }

  try {
    parse(buf.length, 0);
  } catch {
    result.errors++;
  }

  return result;
}

// Create a minimal valid WebM with Opus audio track (for testing)
export function createTestWebM(includeAudioData?: boolean): Buffer {
  const parts: Buffer[] = [];

  // EBML Header
  const docType = Buffer.from("webm");
  const ebmlContent = Buffer.concat([
    Buffer.from([0x42, 0x86, 0x81, 0x01]), // EBMLVersion = 1
    Buffer.from([0x42, 0xf7, 0x81, 0x01]), // EBMLReadVersion = 1
    Buffer.from([0x42, 0xf2, 0x81, 0x04]), // EBMLMaxIDLength = 4
    Buffer.from([0x42, 0xf3, 0x81, 0x08]), // EBMLMaxSizeLength = 8
    Buffer.from([0x42, 0x82, 0x80 | docType.length]), // DocType
    docType,
    Buffer.from([0x42, 0x87, 0x81, 0x04]), // DocTypeVersion = 4
    Buffer.from([0x42, 0x85, 0x81, 0x02]), // DocTypeReadVersion = 2
  ]);

  // EBML element: ID + size + content
  parts.push(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // EBML ID
  parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ebmlContent.length])); // size
  parts.push(ebmlContent);

  // Segment (unknown size for streaming)
  parts.push(Buffer.from([0x18, 0x53, 0x80, 0x67])); // Segment ID
  parts.push(Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])); // unknown size

  // Tracks
  const codecId = Buffer.from("A_OPUS");
  const trackEntryContent = Buffer.concat([
    Buffer.from([0xd7, 0x81, 0x01]), // TrackNumber = 1
    Buffer.from([0x83, 0x81, 0x02]), // TrackType = 2 (audio)
    Buffer.from([0x86, 0x80 | codecId.length]), // CodecID
    codecId,
  ]);

  const trackEntry = Buffer.concat([
    Buffer.from([0xae, 0x80 | trackEntryContent.length]),
    trackEntryContent,
  ]);

  parts.push(Buffer.from([0x16, 0x54, 0xae, 0x6b])); // Tracks ID
  parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, trackEntry.length]));
  parts.push(trackEntry);

  if (includeAudioData) {
    // Cluster with SimpleBlock
    const audioPayload = Buffer.alloc(64, 0xAB); // Fake audio
    const simpleBlock = Buffer.concat([
      Buffer.from([0x81]), // Track 1 (VINT)
      Buffer.from([0x00, 0x00]), // Timecode relative to cluster
      Buffer.from([0x80]), // Flags (keyframe)
      audioPayload,
    ]);

    const clusterContent = Buffer.concat([
      Buffer.from([0xe7, 0x81, 0x00]), // Timecode = 0
      Buffer.from([0xa3, 0x40 | (simpleBlock.length >> 8), simpleBlock.length & 0xff]),
      simpleBlock,
    ]);

    parts.push(Buffer.from([0x1f, 0x43, 0xb6, 0x75])); // Cluster ID
    parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, clusterContent.length]));
    parts.push(clusterContent);
  }

  return Buffer.concat(parts);
}
