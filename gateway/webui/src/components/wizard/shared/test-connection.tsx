import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { ActionButton } from "../../common/foundation.tsx";
import { Notice } from "../../common/composites.tsx";

export interface TestConnectionProps {
  onTest: () => Promise<{
    ok: boolean;
    modelCount?: number;
    sampleModels?: string[];
    error?: string;
  }>;
  onResult: (ok: boolean) => void;
}

export function TestConnection({
  onTest,
  onResult,
}: TestConnectionProps): JSX.Element {
  const [state, setState] = useState<"idle" | "testing" | "ok" | "fail">(
    "idle"
  );
  const [detail, setDetail] = useState<string>("");

  async function run() {
    setState("testing");
    setDetail("");
    try {
      const r = await onTest();
      if (r.ok) {
        setState("ok");
        const count = r.modelCount ?? 0;
        if (count === 0) {
          setDetail("Connection OK");
        } else {
          setDetail(
            `Reached ${count} models${
              r.sampleModels?.length
                ? ` (e.g. ${r.sampleModels.join(", ")})`
                : ""
            }`
          );
        }
      } else {
        setState("fail");
        setDetail(r.error ?? "Test failed");
      }
      onResult(r.ok);
    } catch (e: unknown) {
      setState("fail");
      setDetail(e instanceof Error ? e.message : String(e));
      onResult(false);
    }
  }

  return (
    <div class={`test-connection test-connection--${state}`}>
      <ActionButton loading={state === "testing"} onClick={() => void run()}>Test connection</ActionButton>
      {state === "ok" && <Notice tone="success">{detail}</Notice>}
      {state === "fail" && <Notice tone="error">{detail}</Notice>}
    </div>
  );
}
