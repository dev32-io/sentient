import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STACK_SCRIPT = readFileSync(join(import.meta.dir, "..", "..", "..", "scripts", "stack.sh"), "utf-8");

test("CONTRACT: local stack startup and status probe required-service readiness through gateway and door", () => {
  expect(STACK_SCRIPT).toContain('DIRECT_READY_URL="$DIRECT_URL/api/v1/ready"');
  expect(STACK_SCRIPT).toContain('DOOR_READY_URL="${CANONICAL_URL}api/v1/ready"');
  expect(STACK_SCRIPT.match(/probe "\$DIRECT_READY_URL"/g)?.length).toBe(2);
  expect(STACK_SCRIPT.match(/probe "\$DOOR_READY_URL"/g)?.length).toBe(2);
});
