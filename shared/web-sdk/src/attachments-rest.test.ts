import { describe, expect, it, vi } from "vitest";
import { type AttachmentsRestError, createAttachmentsRest } from "./attachments-rest.ts";

class FakeXhr {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  status = 201;
  responseText = JSON.stringify({
    attachmentId: "att_0123456789abcdef0123456789abcdef",
    displayName: "fixture.txt",
    contentType: "text/plain",
    mediaKind: "text",
    size: 7,
  });
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: Blob | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: Blob): void {
    this.body = body;
    this.upload.onprogress?.({ loaded: body.size, total: body.size, lengthComputable: true } as ProgressEvent);
    this.onload?.();
  }
  abort(): void {
    this.onabort?.();
  }
}

describe("attachments REST", () => {
  it("uploads raw bytes with stable identities, auth, and progress", async () => {
    const xhr = new FakeXhr();
    const progress = vi.fn();
    const client = createAttachmentsRest({
      baseUrl: "https://gateway.test/api/v1",
      token: () => "synthetic-token",
      createXhr: () => xhr as unknown as XMLHttpRequest,
    });
    const blob = new Blob(["fixture"], { type: "text/plain" });

    const ref = await client.upload({
      sendAttemptId: "pending-1",
      fileIdentity: "file-1",
      displayName: "fixture.txt",
      contentType: "text/plain",
      blob,
      onProgress: progress,
    });

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain("sendAttemptId=pending-1");
    expect(xhr.url).toContain("fileIdentity=file-1");
    expect(xhr.url).not.toContain("synthetic-token");
    expect(xhr.headers.authorization).toBe("Bearer synthetic-token");
    expect(xhr.body).toBe(blob);
    expect(progress).toHaveBeenCalledWith(7, 7);
    expect(ref.attachmentId).toBe("att_0123456789abcdef0123456789abcdef");
  });

  it("uses authenticated blob downloads and rejects malformed upload responses", async () => {
    const fetchFn = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("fixture", { headers: { "content-type": "text/plain" } }),
    );
    const client = createAttachmentsRest({
      baseUrl: "https://gateway.test/api/v1",
      token: () => "synthetic-token",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await (await client.preview("att_0123456789abcdef0123456789abcdef")).text()).toBe("fixture");
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://gateway.test/api/v1/attachments/att_0123456789abcdef0123456789abcdef/preview",
    );
    expect(fetchFn.mock.calls[0]?.[0]).not.toContain("synthetic-token");
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer synthetic-token" });
    expect(await (await client.download("att_0123456789abcdef0123456789abcdef")).text()).toBe("fixture");

    const xhr = new FakeXhr();
    xhr.responseText = JSON.stringify({ attachmentId: "bad" });
    const invalid = createAttachmentsRest({
      baseUrl: "https://gateway.test/api/v1",
      token: () => "token",
      createXhr: () => xhr as unknown as XMLHttpRequest,
    });
    await expect(
      invalid.upload({
        sendAttemptId: "pending-1",
        fileIdentity: "file-1",
        displayName: "fixture.txt",
        contentType: "text/plain",
        blob: new Blob(["fixture"]),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" } satisfies Partial<AttachmentsRestError>);
  });
});
