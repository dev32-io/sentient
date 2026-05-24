import { expect, test } from "bun:test";

test("dockerode imports cleanly under bun", async () => {
  const Dockerode = (await import("dockerode")).default;
  expect(typeof Dockerode).toBe("function");
});
