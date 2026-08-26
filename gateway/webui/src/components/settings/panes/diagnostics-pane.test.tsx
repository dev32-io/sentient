import { render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ readiness: null as boolean | null, versions: null as Record<string, unknown> | null }));
vi.mock("../../../hooks/use-system-readiness.ts", () => ({ useSystemReadiness: () => hooks.readiness }));
vi.mock("../../../hooks/use-service-versions.ts", () => ({ useServiceVersions: () => hooks.versions }));

import { DiagnosticsPane } from "./diagnostics-pane.tsx";

describe("DiagnosticsPane trust-safe status", () => {
  beforeEach(() => { hooks.readiness = null; hooks.versions = null; });

  it("does not claim readiness or a version before either is observed", () => {
    render(<DiagnosticsPane token="token" />);
    expect(screen.getByText("Checking readiness")).not.toBeNull();
    expect(screen.getAllByText("Unknown")).toHaveLength(4);
  });

  it("shows an observed failure with recovery guidance", () => {
    hooks.readiness = false;
    render(<DiagnosticsPane token="token" />);
    expect(screen.getByRole("alert").textContent).toContain("did not observe");
    expect(screen.getByRole("button", { name: "Reload diagnostics" })).not.toBeNull();
  });

  it("formats sanitized component versions only inside Diagnostics", () => {
    hooks.readiness = true;
    hooks.versions = { gateway: "1.2.3", hermes: "unknown", stt_service: "v4", tts_service: "" };
    render(<DiagnosticsPane token="token" />);
    expect(screen.getByTestId("diagnostics-version-gateway").textContent).toBe("v1.2.3");
    expect(screen.getByTestId("diagnostics-version-hermes").textContent).toBe("Unknown");
    expect(screen.getByTestId("diagnostics-version-stt_service").textContent).toBe("v4");
  });
});
