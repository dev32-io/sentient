import { describe, expect, it } from "bun:test";
import { MusicAdapterError, type MusicWebSocket, NativeMusicAdapter } from "./music-adapter.js";

class FakeSocket implements MusicWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  respond(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function adapterWith(
  sockets: FakeSocket[],
  options: { requestTimeoutMs?: number; reconnectAttempts?: number } = {},
): NativeMusicAdapter {
  return new NativeMusicAdapter("http://mass.local:8095", "secret-token", {
    connectTimeoutMs: 100,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    reconnectAttempts: options.reconnectAttempts ?? 1,
    websocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
}

function authenticate(socket: FakeSocket): void {
  socket.open();
  const auth = socket.sent[0];
  expect(auth?.command).toBe("auth");
  expect(auth?.args).toEqual({ token: "secret-token" });
  socket.respond({ message_id: auth?.message_id, result: { authenticated: true } });
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("NativeMusicAdapter protocol", () => {
  it("authenticates first and correlates concurrent request IDs", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets);
    const first = adapter.listPlayers(new AbortController().signal);
    const second = adapter.browse(null, 10, new AbortController().signal);
    await tick();
    const socket = sockets[0] as FakeSocket;
    authenticate(socket);
    await tick();
    const playersRequest = socket.sent.find((message) => message.command === "players/all");
    const browseRequest = socket.sent.find((message) => message.command === "music/browse");
    expect(playersRequest?.message_id).not.toBe(browseRequest?.message_id);
    socket.respond({
      message_id: browseRequest?.message_id,
      result: [{ uri: "library://album/2", media_type: "album", name: "Two" }],
    });
    socket.respond({
      message_id: playersRequest?.message_id,
      result: [{ player_id: "p1", name: "Kitchen", available: true }],
    });
    expect(await first).toEqual([expect.objectContaining({ id: "p1", name: "Kitchen" })]);
    expect(await second).toEqual([expect.objectContaining({ id: "library://album/2", name: "Two" })]);
  });

  it("fails closed when authentication is rejected", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets, { reconnectAttempts: 0 });
    const call = adapter.listPlayers(new AbortController().signal);
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    socket.respond({ message_id: socket.sent[0]?.message_id, error_code: 401, details: "invalid token" });
    await expect(call).rejects.toMatchObject({ kind: "authentication" });
    expect(socket.sent.some((message) => message.command === "players/all")).toBe(false);
  });

  it("ignores malformed events but rejects a malformed correlated response", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets);
    const call = adapter.listPlayers(new AbortController().signal);
    await tick();
    authenticate(sockets[0] as FakeSocket);
    await tick();
    const request = (sockets[0] as FakeSocket).sent.find((message) => message.command === "players/all");
    (sockets[0] as FakeSocket).respond({ event: "player_updated", data: "not trusted" });
    (sockets[0] as FakeSocket).respond({ message_id: request?.message_id, unexpected: true });
    await expect(call).rejects.toMatchObject({ kind: "protocol", dispatched: true });
  });

  it("detaches a cancelled request without corrupting the shared connection", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets);
    const controller = new AbortController();
    const cancelled = adapter.listPlayers(controller.signal);
    await tick();
    authenticate(sockets[0] as FakeSocket);
    await tick();
    const cancelledRequest = (sockets[0] as FakeSocket).sent.find((message) => message.command === "players/all");
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    (sockets[0] as FakeSocket).respond({ message_id: cancelledRequest?.message_id, result: [] });

    const next = adapter.browse(null, 10, new AbortController().signal);
    await tick();
    const nextRequest = (sockets[0] as FakeSocket).sent.find((message) => message.command === "music/browse");
    (sockets[0] as FakeSocket).respond({ message_id: nextRequest?.message_id, result: [] });
    expect(await next).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it("reconnects for later operations and ignores late responses from the evicted connection", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets);
    const first = adapter.listPlayers(new AbortController().signal);
    await tick();
    authenticate(sockets[0] as FakeSocket);
    await tick();
    const oldRequest = (sockets[0] as FakeSocket).sent.find((message) => message.command === "players/all");
    (sockets[0] as FakeSocket).close(1006);
    await expect(first).rejects.toMatchObject({ kind: "unavailable", dispatched: true });

    const later = adapter.listPlayers(new AbortController().signal);
    await tick();
    authenticate(sockets[1] as FakeSocket);
    await tick();
    const newRequest = (sockets[1] as FakeSocket).sent.find((message) => message.command === "players/all");
    (sockets[0] as FakeSocket).respond({
      message_id: oldRequest?.message_id,
      result: [{ player_id: "wrong", name: "Wrong" }],
    });
    (sockets[1] as FakeSocket).respond({
      message_id: newRequest?.message_id,
      result: [{ player_id: "new", name: "Living Room" }],
    });
    expect(await later).toEqual([expect.objectContaining({ id: "new" })]);
  });

  it("marks an acknowledged mutation unverified when player state was not observed", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets);
    const call = adapter.setVolume("p1", 40, new AbortController().signal);
    await tick();
    authenticate(sockets[0] as FakeSocket);
    await tick();
    const request = (sockets[0] as FakeSocket).sent.find((message) => message.command === "players/cmd/volume_set");
    (sockets[0] as FakeSocket).respond({ message_id: request?.message_id, result: null });
    expect(await call).toEqual({ outcome: "accepted_unverified" });
  });

  it("never replays an ambiguous mutation after disconnect", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets);
    const call = adapter.setVolume("p1", 40, new AbortController().signal);
    await tick();
    authenticate(sockets[0] as FakeSocket);
    await tick();
    expect(
      (sockets[0] as FakeSocket).sent.filter((message) => message.command === "players/cmd/volume_set"),
    ).toHaveLength(1);
    (sockets[0] as FakeSocket).close(1006);
    expect(await call).toEqual({ outcome: "accepted_unverified" });
    expect(sockets).toHaveLength(1);
  });

  it("bounds failed connection attempts", async () => {
    let attempts = 0;
    const adapter = new NativeMusicAdapter("http://mass.local:8095", "token", {
      reconnectAttempts: 1,
      websocketFactory: () => {
        attempts += 1;
        throw new Error("down");
      },
    });
    await expect(adapter.listPlayers(new AbortController().signal)).rejects.toBeInstanceOf(MusicAdapterError);
    expect(attempts).toBe(2);
  });

  it("returns accepted_unverified on a mutating response timeout", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = adapterWith(sockets, { requestTimeoutMs: 5 });
    const call = adapter.play("p1", "library://track/1", new AbortController().signal);
    await tick();
    authenticate(sockets[0] as FakeSocket);
    expect(await call).toEqual({ outcome: "accepted_unverified" });
    expect(
      (sockets[0] as FakeSocket).sent.filter((message) => message.command === "player_queues/play_media"),
    ).toHaveLength(1);
  });
});
