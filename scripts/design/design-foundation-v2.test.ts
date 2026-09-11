import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTRACT_PATH,
  ROOT,
  assertProjectionCurrent,
  readAndValidateContract,
  renderOutputs,
  sha256,
  validateContract,
} from "./design-foundation-v2";

describe("design foundation v2 contract", () => {
  test("validates the committed JSON Schema and exact locked values", async () => {
    const { contract } = await readAndValidateContract();
    const schema = JSON.parse(await readFile(join(ROOT, "shared/mobile-sdk/design-foundation-v2.schema.json"), "utf8"));
    const validateSchema = new Ajv2020({ strict: false }).compile(schema);
    expect(validateSchema(contract), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(() => validateContract(contract)).not.toThrow();
    expect(contract.colors.ember).toBe("#F2A06A");
    expect(contract.motion).toEqual({ feedbackMs: 150, stateTransitionMs: 250, respondingCadenceMs: 1550 });
    expect(contract.avatars.sentient.states).toEqual(["idle", "thinking", "responding"]);
  });

  test("proves schema-only additional-property and uniqueness constraints", async () => {
    const schema = JSON.parse(await readFile(join(ROOT, "shared/mobile-sdk/design-foundation-v2.schema.json"), "utf8"));
    const validateSchema = new Ajv2020({ strict: false }).compile(schema);
    const additional = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
    additional.unreviewed = true;
    expect(validateSchema(additional)).toBe(false);
    expect(validateSchema.errors?.some((error) => error.keyword === "additionalProperties")).toBe(true);

    const duplicateState = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
    duplicateState.componentStates.push(duplicateState.componentStates[0]);
    expect(validateSchema(duplicateState)).toBe(false);
    expect(validateSchema.errors?.some((error) => error.keyword === "uniqueItems")).toBe(true);
  });

  test("rejects a malformed or expanded avatar state contract", async () => {
    const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
    delete contract.typography.lineHeights;
    expect(() => validateContract(contract)).toThrow("typography.lineHeights is required");

    const withListening = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
    withListening.avatars.sentient.states.push("listening");
    expect(() => validateContract(withListening)).toThrow("locked v2 value");
  });

  test("generation is deterministic and all projections agree on version and hash", async () => {
    const { contract, hash } = await readAndValidateContract();
    expect(renderOutputs(contract, hash)).toEqual(renderOutputs(contract, hash));
    for (const output of Object.values(renderOutputs(contract, hash))) {
      expect(output).toContain(`Design foundation ${contract.version}; contract sha256: ${hash}`);
    }
  });

  test("rejects a manually edited generated projection", () => {
    expect(() => assertProjectionCurrent(Buffer.from("committed"), Buffer.from("regenerated"), "tokens.ts")).toThrow(
      "tokens.ts is stale",
    );
  });

  test("keeps the manual Android v1 declarations byte-for-byte unchanged", async () => {
    const v1 = await readFile(
      join(ROOT, "shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt"),
    );
    expect(sha256(v1)).toBe("489e6b607eace748821d1e5ecd346f54742639b028fd23cd7831ade725d337bb");
  });
});
