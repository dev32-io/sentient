import { imageSize } from "image-size";

const MAX_EDGE = 640;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
// Bounds source pixels, not decoder peak RSS; at most two inputs decode concurrently.
const MAX_DECODED_PIXELS = 16 * 1024 * 1024;
const MAX_CONCURRENT_PREVIEWS = 2;

let activePreviews = 0;
const waitingPreviews: Array<() => void> = [];

function nextPreview(): void {
  if (activePreviews >= MAX_CONCURRENT_PREVIEWS) return;
  waitingPreviews.shift()?.();
}

function withPreviewSlot<T>(signal: AbortSignal, prepare: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) {
        reject(signal.reason);
        nextPreview();
        return;
      }
      activePreviews += 1;
      void prepare()
        .then(resolve, reject)
        .finally(() => {
          activePreviews -= 1;
          nextPreview();
        });
    };
    const cancel = () => {
      const index = waitingPreviews.indexOf(start);
      if (index >= 0) waitingPreviews.splice(index, 1);
      reject(signal.reason);
    };
    if (activePreviews < MAX_CONCURRENT_PREVIEWS) start();
    else {
      waitingPreviews.push(start);
      signal.addEventListener("abort", cancel, { once: true });
    }
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas preview encoding failed."))),
      "image/webp",
      0.82,
    );
  });
}

async function hasBoundedDimensions(file: Blob, signal: AbortSignal): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, MAX_HEADER_BYTES).arrayBuffer());
  if (signal.aborted) throw signal.reason;
  try {
    const { type, width, height } = imageSize(header);
    return (
      (type === "jpg" || type === "png") &&
      Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width <= MAX_DECODED_PIXELS / height
    );
  } catch {
    return false;
  }
}

/** Returns a static display-only poster. Original File remains draft/upload source. */
export async function prepareLocalImagePreview(file: Blob, signal: AbortSignal): Promise<Blob | null> {
  if (signal.aborted) throw signal.reason;
  if (file.size > MAX_SOURCE_BYTES || typeof createImageBitmap !== "function") return null;
  if (!(await hasBoundedDimensions(file, signal))) return null;
  return withPreviewSlot(signal, async () => {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (signal.aborted) throw signal.reason;
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas preview unavailable.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas);
      if (signal.aborted) throw signal.reason;
      return blob;
    } finally {
      bitmap?.close();
    }
  });
}
