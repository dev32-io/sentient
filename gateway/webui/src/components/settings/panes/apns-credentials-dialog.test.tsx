import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApnsCredentialsDialog } from "./apns-credentials-dialog.tsx";

const emptyStatus = { has_key: false, has_key_id: false, has_team_id: false };
const completeStatus = { has_key: true, has_key_id: true, has_team_id: true };

function p8File(
  name = "AuthKey_ABCDEFGHIJ.p8",
  contents = "private-key-contents",
  read: Promise<string> = Promise.resolve(contents),
): File {
  const file = new File([contents], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "text", { value: vi.fn().mockReturnValue(read) });
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ApnsCredentialsDialog", () => {
  it("focuses Key ID and supports bad-file recovery, drop, filename prefill, and removal", async () => {
    const { container } = render(
      <ApnsCredentialsDialog status={emptyStatus} onSave={vi.fn()} onApply={vi.fn()} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );
    const keyId = screen.getByRole("textbox", { name: "Key ID" }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(keyId));
    const input = screen.getByLabelText("Apple private key file") as HTMLInputElement;
    const zone = input.closest("label");
    expect(zone).toBeTruthy();

    fireEvent.change(input, { target: { files: [p8File("not-a-key.txt")] } });
    expect((await screen.findByRole("alert")).textContent).toContain("Choose an Apple .p8 private key file.");

    const valid = p8File();
    fireEvent.dragEnter(zone as HTMLLabelElement, { dataTransfer: { files: [valid] } });
    expect(zone?.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(zone as HTMLLabelElement, { dataTransfer: { files: [valid] } });
    await waitFor(() => expect(keyId.value).toBe("ABCDEFGHIJ"));
    expect(screen.getByText("AuthKey_ABCDEFGHIJ.p8")).toBeTruthy();
    expect(container.textContent).not.toContain("%");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("AuthKey_ABCDEFGHIJ.p8")).toBeNull();
    expect((screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["invalid extension", () => p8File("not-a-key.txt")],
    ["oversized file", () => p8File("AuthKey_ABCDEFGHIJ.p8", "x".repeat(16 * 1024 + 1))],
  ])("stops reading when a pending file is replaced by an %s", async (_description, invalidFile) => {
    const pendingRead = Promise.withResolvers<string>();
    const onSave = vi.fn();
    render(
      <ApnsCredentialsDialog status={emptyStatus} onSave={onSave} onApply={vi.fn()} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );
    const input = screen.getByLabelText("Apple private key file");

    fireEvent.change(input, { target: { files: [p8File("AuthKey_ABCDEFGHIJ.p8", "stale-key", pendingRead.promise)] } });
    expect(screen.getByText("Reading selected file…")).toBeTruthy();
    fireEvent.change(input, { target: { files: [invalidFile()] } });

    expect(screen.queryByText("Reading selected file…")).toBeNull();
    pendingRead.resolve("stale-key");
    await pendingRead.promise;
    await waitFor(() => expect((screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement).disabled).toBe(true));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps current file bytes and a manually entered Key ID when stale reads settle", async () => {
    const staleRead = Promise.withResolvers<string>();
    const currentRead = Promise.withResolvers<string>();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <ApnsCredentialsDialog status={emptyStatus} onSave={onSave} onApply={onApply} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );
    const input = screen.getByLabelText("Apple private key file");
    const keyId = screen.getByRole("textbox", { name: "Key ID" }) as HTMLInputElement;

    fireEvent.change(input, { target: { files: [p8File("AuthKey_ABCDEFGHIJ.p8", "stale-key", staleRead.promise)] } });
    fireEvent.change(input, { target: { files: [p8File("AuthKey_KLMNOPQRST.p8", "current-key", currentRead.promise)] } });
    fireEvent.input(keyId, { target: { value: "ZXCVBNMASD" } });
    fireEvent.input(screen.getByRole("textbox", { name: "Team ID" }), { target: { value: "1234567890" } });

    currentRead.resolve("current-key");
    await waitFor(() => expect((screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement).disabled).toBe(false));
    staleRead.resolve("stale-key");
    await staleRead.promise;
    await waitFor(() => expect(keyId.value).toBe("ZXCVBNMASD"));
    fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith({
      private_key_p8: "current-key",
      key_id: "ZXCVBNMASD",
      team_id: "1234567890",
    }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("keeps replacement disabled until complete, then preserves saved state across activation retry", async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const onApply = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(
      <ApnsCredentialsDialog status={emptyStatus} onSave={onSave} onApply={onApply} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );
    const save = screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.input(screen.getByRole("textbox", { name: "Team ID" }), { target: { value: "1234567890" } });
    const file = p8File();
    fireEvent.change(screen.getByLabelText("Apple private key file"), { target: { files: [file] } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Team ID" }) as HTMLInputElement).disabled).toBe(true));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    resolveSave();

    await screen.findByText("Credentials saved, activation failed");
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      private_key_p8: "private-key-contents",
      key_id: "ABCDEFGHIJ",
      team_id: "1234567890",
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(file.name)).toBeNull();
    expect(save.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Apply saved credentials" }));
    await screen.findByText("Transport running");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(screen.getByText("This does not confirm Apple acceptance or phone delivery.")).toBeTruthy();
  });

  it("keeps replacement draft and does not auto-apply after an ambiguous save response", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("network-error")).mockResolvedValueOnce(undefined);
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <ApnsCredentialsDialog status={emptyStatus} onSave={onSave} onApply={onApply} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.input(screen.getByRole("textbox", { name: "Team ID" }), { target: { value: "1234567890" } });
    fireEvent.change(screen.getByLabelText("Apple private key file"), { target: { files: [p8File()] } });
    const save = screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await screen.findByText("Credential save could not be confirmed");
    expect(screen.getByText("Retrying the same replacement is safe.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Closing cannot undo credentials that may already have been saved.", { exact: false })).toBeTruthy();
    expect(screen.getByText("AuthKey_ABCDEFGHIJ.p8")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Key ID" }) as HTMLInputElement).value).toBe("ABCDEFGHIJ");
    expect((screen.getByRole("textbox", { name: "Team ID" }) as HTMLInputElement).value).toBe("1234567890");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));
    await screen.findByText("Credentials saved and transport running");
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("requires correction after the server rejects the credential schema", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("schema"));
    const onApply = vi.fn();
    render(
      <ApnsCredentialsDialog status={emptyStatus} onSave={onSave} onApply={onApply} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.input(screen.getByRole("textbox", { name: "Team ID" }), { target: { value: "1234567890" } });
    fireEvent.change(screen.getByLabelText("Apple private key file"), { target: { files: [p8File()] } });
    const save = screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await screen.findByText("Credential replacement rejected");
    expect(screen.getByText("Correct the fields or choose a different private key before retrying.", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Credential save could not be confirmed")).toBeNull();
    expect(screen.getByText("AuthKey_ABCDEFGHIJ.p8")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("clears busy state and permits retry when activation response is unconfirmed", async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error("network-error")).mockResolvedValueOnce(undefined);
    render(
      <ApnsCredentialsDialog status={completeStatus} onSave={vi.fn()} onApply={onApply} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply saved credentials" }));
    await screen.findByText("Activation could not be confirmed");
    expect(screen.getByText("Transport may have started despite the missing response.", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Credentials saved, activation failed")).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    const retry = screen.getByRole("button", { name: "Apply saved credentials" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    fireEvent.click(retry);
    await screen.findByText("Transport running");
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("applies complete saved credentials after reload without a file", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onSave = vi.fn();
    render(
      <ApnsCredentialsDialog status={completeStatus} onSave={onSave} onApply={onApply} onCredentialsSaved={vi.fn()} onClose={vi.fn()} />,
    );

    expect((screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply saved credentials" }));
    await screen.findByText("Transport running");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Escape cancels unsaved draft, restores focus, and makes no rollback claim", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Update</button>
        {open && <ApnsCredentialsDialog status={completeStatus} onSave={vi.fn()} onApply={vi.fn()} onCredentialsSaved={vi.fn()} onClose={() => setOpen(false)} />}
      </>;
    }
    render(<Harness />);
    const update = screen.getByRole("button", { name: "Update" });
    update.focus();
    fireEvent.click(update);
    fireEvent.input(screen.getByRole("textbox", { name: "Team ID" }), { target: { value: "1234567890" } });
    expect(screen.getByText("Closing does not undo credentials already saved.", { exact: false })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(update);

    fireEvent.click(update);
    expect((screen.getByRole("textbox", { name: "Team ID" }) as HTMLInputElement).value).toBe("");
  });
});
