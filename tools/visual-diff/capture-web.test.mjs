import assert from "node:assert/strict";
import test from "node:test";
import { captureCaseId, visualDiffTransitionTimeMs } from "./capture-web.mjs";

test("web motion routes exactly one component/recording namespace and preserves time", () => {
  for (const recording of ["segmented-control--comfortable-to-compact", "disclosure--closed-to-open", "pin-entry--complete-to-success", "voice-control--auto-loop"]) {
    const path = `design/prototype/foundation-components/handoff/recordings/${recording}/frame-002--0110ms.png`;
    const id = captureCaseId(path);
    assert.equal(id, `${recording}--frame-002--0110ms`);
    assert.equal(visualDiffTransitionTimeMs(id), recording.startsWith("voice-control") ? undefined : 110);
  }
  assert.equal(captureCaseId("design/prototype/foundation-components/handoff/recordings/sentient-avatar--thinking-loop/frame-000--0000ms.png"), "sentient-identity--thinking-loop--frame-000--0000ms");
  assert.equal(captureCaseId("design/prototype/common-composites/handoff/static/no-results--empty.png"), "no-results--default--empty");
});
