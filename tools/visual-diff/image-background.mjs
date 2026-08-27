import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";

export function parseHexColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value ?? "");
  if (!match) throw new Error("--background must be a six-digit hex color");
  const packed = Number.parseInt(match[1], 16);
  return {
    red: (packed >> 16) & 0xff,
    green: (packed >> 8) & 0xff,
    blue: packed & 0xff,
  };
}

export async function compositePng(inputPath, outputPath, background) {
  const image = PNG.sync.read(await readFile(inputPath));
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3] / 255;
    image.data[offset] = Math.round((image.data[offset] * alpha) + (background.red * (1 - alpha)));
    image.data[offset + 1] = Math.round((image.data[offset + 1] * alpha) + (background.green * (1 - alpha)));
    image.data[offset + 2] = Math.round((image.data[offset + 2] * alpha) + (background.blue * (1 - alpha)));
    image.data[offset + 3] = 255;
  }
  await writeFile(outputPath, PNG.sync.write(image));
}
