import variants from "../build-variants.json";

export type BuildVariant = keyof typeof variants;
export const BUILD_VARIANTS = variants;

/** Build identity is embedded by packaged builds; source entrypoints select it explicitly. */
export function getBuildVariant(name = process.env.SENTIENT_BUILD_VARIANT ?? "Release") {
  if (name !== "Debug" && name !== "Release") throw new Error(`Invalid SENTIENT_BUILD_VARIANT: ${name}`);
  return variants[name];
}
