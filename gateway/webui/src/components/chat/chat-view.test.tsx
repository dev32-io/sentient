import { act, cleanup, render } from "@testing-library/preact";
import type { JSX } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types.ts";
import { ChatView } from "./chat-view.tsx";

vi.mock("../common/sentient-identity.tsx", () => ({
  SentientIdentity: ({ label }: { label: string }): JSX.Element => (
    <span aria-label={label} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const currentUser = { displayName: "Maya", avatarTint: "terra" as const };
const message = (id: string, pendingId?: string): ChatMessage => ({
  id,
  role: "user",
  text: id,
  timestamp: 1000,
  isStreaming: false,
  ...(pendingId ? { pendingId } : {}),
});

function installRafClock() {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  return {
    advance(ms: number) {
      now += ms;
      const frame = [...callbacks.values()];
      callbacks.clear();
      act(() => frame.forEach((callback) => callback(now)));
    },
    pending: () => callbacks.size,
  };
}

function installScrollTo() {
  const scrollTo = vi.fn(function (
    this: HTMLElement,
    options: ScrollToOptions,
  ) {
    if (typeof options.top === "number") this.scrollTop = options.top;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return scrollTo;
}

describe("ChatView local send behavior", () => {
  it("animates owned sends for 250ms and ignores per-frame scrollend", () => {
    const clock = installRafClock();
    const scrollTo = installScrollTo();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const scroller = this.closest<HTMLElement>(".chat-view");
        const documentTop =
          this.dataset.pendingId === "pending-local-3"
            ? 1100
            : this.dataset.pendingId === "pending-local-2"
              ? 900
              : 700;
        const top = this.dataset.pendingId
          ? documentTop - (scroller?.scrollTop ?? 0)
          : 0;
        return {
          x: 0,
          y: top,
          top,
          right: 0,
          bottom: 0,
          left: 0,
          width: 0,
          height: 0,
          toJSON() {},
        };
      },
    );

    const view = render(
      <ChatView
        messages={[message("history")]}
        localSendIds={[]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    const scroller = view.container.querySelector<HTMLElement>(".chat-view")!;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scroller.style.setProperty("--chat-bottom-clear", "100px");
    scroller.scrollTop = 300;
    scrollTo.mockClear();

    view.rerender(
      <ChatView
        messages={[message("history"), message("local", "pending-local")]}
        localSendIds={["pending-local"]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );

    const rows =
      view.container.querySelectorAll<HTMLElement>("[data-message-key]");
    expect(rows[0]?.classList.contains("message-bubble--entering")).toBe(false);
    expect(rows[1]?.classList.contains("message-bubble--entering")).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();

    clock.advance(125);
    expect(scroller.scrollTop).toBeCloseTo(460);
    scroller.dispatchEvent(new Event("scrollend"));
    clock.advance(125);
    expect(scroller.scrollTop).toBe(620);
    expect(clock.pending()).toBe(0);

    view.rerender(
      <ChatView
        messages={[
          message("history"),
          message("local", "pending-local"),
          message("local-2", "pending-local-2"),
        ]}
        localSendIds={["pending-local", "pending-local-2"]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(clock.pending()).toBe(1);
    clock.advance(125);
    expect(scroller.scrollTop).toBe(720);

    view.rerender(
      <ChatView
        messages={[
          message("history"),
          message("local", "pending-local"),
          message("local-2", "pending-local-2"),
        ]}
        localSendIds={[
          "pending-local",
          "pending-local-2",
          "pending-local-3",
        ]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(clock.pending()).toBe(0);
    expect(scroller.scrollTop).toBe(720);
    clock.advance(125);
    expect(scroller.scrollTop).toBe(720);

    view.rerender(
      <ChatView
        messages={[
          message("history"),
          message("local", "pending-local"),
          message("local-2", "pending-local-2"),
          message("local-3", "pending-local-3"),
        ]}
        localSendIds={[
          "pending-local",
          "pending-local-2",
          "pending-local-3",
        ]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(clock.pending()).toBe(1);
    clock.advance(125);
    expect(scroller.scrollTop).toBe(870);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    expect(clock.pending()).toBe(0);
    clock.advance(125);
    expect(scroller.scrollTop).toBe(870);
  });

  it("tracks target and tail resize without restarting owned-send travel", () => {
    const clock = installRafClock();
    const scrollTo = installScrollTo();
    let resizeContent!: ResizeObserverCallback;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          if (target.classList.contains("chat-view__content"))
            resizeContent = this.callback;
        }
        disconnect() {}
      },
    );
    let targetDocumentTop = 700;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const scroller = this.closest<HTMLElement>(".chat-view");
        const top = this.dataset.pendingId
          ? targetDocumentTop - (scroller?.scrollTop ?? 0)
          : 0;
        const height = this.classList.contains("message-list") ? 200 : 0;
        return {
          x: 0,
          y: top,
          top,
          right: 0,
          bottom: top + height,
          left: 0,
          width: 0,
          height,
          toJSON() {},
        };
      },
    );

    const view = render(
      <ChatView
        messages={[message("history")]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    const scroller = view.container.querySelector<HTMLElement>(".chat-view")!;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 500,
    });
    let contentHeight = 500;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => {
        const content = view.container.querySelector<HTMLElement>(
          ".chat-view__content",
        );
        return (
          contentHeight +
          Number.parseFloat(
            content?.style.getPropertyValue("--chat-owned-tail") || "0",
          )
        );
      },
    });
    scroller.style.setProperty("--chat-bottom-clear", "100px");
    scroller.scrollTop = 300;
    view.rerender(
      <ChatView
        messages={[message("history"), message("local", "pending-local")]}
        localSendIds={["pending-local"]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    const content = view.container.querySelector<HTMLElement>(
      ".chat-view__content",
    )!;
    expect(content.style.getPropertyValue("--chat-owned-tail")).toBe("620px");
    expect(scrollTo).not.toHaveBeenCalled();

    contentHeight += 50;
    act(() =>
      resizeContent(
        [{ contentRect: new DOMRect(0, 0, 0, 550) } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(content.style.getPropertyValue("--chat-owned-tail")).toBe("570px");
    expect(scrollTo).not.toHaveBeenCalled();

    targetDocumentTop += 30;
    act(() =>
      resizeContent(
        [{ contentRect: new DOMRect(0, 0, 0, 550) } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(content.style.getPropertyValue("--chat-owned-tail")).toBe("600px");
    clock.advance(250);
    expect(scroller.scrollTop).toBe(650);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    contentHeight += 50;
    act(() =>
      resizeContent(
        [{ contentRect: new DOMRect(0, 0, 0, 600) } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(content.style.getPropertyValue("--chat-owned-tail")).toBe("550px");
    expect(scrollTo).toHaveBeenCalledTimes(1);

    scroller.dispatchEvent(new WheelEvent("wheel"));
    contentHeight += 50;
    act(() =>
      resizeContent(
        [{ contentRect: new DOMRect(0, 0, 0, 650) } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(content.style.getPropertyValue("--chat-owned-tail")).toBe("550px");
    expect(scrollTo).toHaveBeenCalledTimes(1);

    scroller.scrollTop = 300;
    view.rerender(
      <ChatView
        messages={[]}
        localSendIds={[]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(content.style.getPropertyValue("--chat-owned-tail")).toBe("");
    expect(scroller.scrollTop).toBe(0);
  });

  it("uses live dock geometry when inherited clearance still has the old height", () => {
    const clock = installRafClock();
    const scrollTo = installScrollTo();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const scroller = this.closest<HTMLElement>(".chat-view");
        const top = this.dataset.pendingId
          ? 329.625 - (scroller?.scrollTop ?? 0)
          : this.classList.contains("app-shell__dock")
            ? 494
            : 0;
        const bottom = this.classList.contains("chat-view") ? 779 : top;
        return {
          x: 0,
          y: top,
          top,
          right: 0,
          bottom,
          left: 0,
          width: 0,
          height: bottom - top,
          toJSON() {},
        };
      },
    );

    const props = {
      transcript: "",
      currentTurnId: null,
      activeCycleState: "idle" as const,
      currentUser,
    };
    const view = render(
      <div class="app-shell">
        <ChatView messages={[message("history")]} {...props} />
        <footer class="app-shell__dock" />
      </div>,
    );
    const scroller = view.container.querySelector<HTMLElement>(".chat-view")!;
    const content = view.container.querySelector<HTMLElement>(
      ".chat-view__content",
    )!;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 779,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () =>
        779 +
        Number.parseFloat(
          content.style.getPropertyValue("--chat-owned-tail") || "0",
        ),
    });
    scroller.style.setProperty("--chat-bottom-clear", "21px");
    scroller.scrollTop = 178;
    scrollTo.mockClear();

    view.rerender(
      <div class="app-shell">
        <ChatView
          messages={[
            message("history"),
            message("local", "pending-local"),
          ]}
          localSendIds={["pending-local"]}
          {...props}
        />
        <footer class="app-shell__dock" />
      </div>,
    );

    expect(scrollTo).not.toHaveBeenCalled();
    clock.advance(250);
    expect(scrollTo).toHaveBeenCalledWith({
      top: 230.825,
      behavior: "auto",
    });
    expect(
      Number.parseFloat(content.style.getPropertyValue("--chat-owned-tail")),
    ).toBeCloseTo(230.825);
  });

  it("cancels pending travel and follows hydrated growth after an empty session boundary", () => {
    const clock = installRafClock();
    const scrollTo = installScrollTo();
    let resizeContent!: ResizeObserverCallback;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          if (target.classList.contains("chat-view__content"))
            resizeContent = this.callback;
        }
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const top = this.dataset.pendingId ? 400 : 0;
        return {
          x: 0,
          y: top,
          top,
          right: 0,
          bottom: 0,
          left: 0,
          width: 0,
          height: 0,
          toJSON() {},
        };
      },
    );
    const props = {
      transcript: "",
      currentTurnId: null,
      activeCycleState: "idle" as const,
      currentUser,
    };
    const view = render(<ChatView messages={[message("history")]} {...props} />);
    const scroller = view.container.querySelector<HTMLElement>(".chat-view")!;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 500,
    });
    let scrollHeight = 900;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    scroller.scrollTop = 100;
    scrollTo.mockClear();
    view.rerender(
      <ChatView
        messages={[message("history"), message("local", "pending-local")]}
        localSendIds={["pending-local"]}
        {...props}
      />,
    );
    expect(clock.pending()).toBe(1);
    clock.advance(100);
    expect(scroller.scrollTop).toBeGreaterThan(100);
    expect(scroller.scrollTop).toBeLessThan(400);

    view.rerender(
      <ChatView
        messages={[]}
        localSendIds={[]}
        status="loading"
        {...props}
      />,
    );
    expect(clock.pending()).toBe(0);
    expect(scroller.scrollTop).toBe(0);
    const callsAfterReset = scrollTo.mock.calls.length;
    clock.advance(150);
    expect(scrollTo).toHaveBeenCalledTimes(callsAfterReset);
    scroller.dispatchEvent(new Event("scroll"));

    view.rerender(
      <ChatView messages={[message("hydrated"), message("reply")]} {...props} />,
    );
    scrollHeight = 1100;
    act(() =>
      resizeContent(
        [{ contentRect: new DOMRect(0, 0, 0, 1100) } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: "auto" });
  });

  it("preserves retained history position and entrance baseline during reconnect", () => {
    installScrollTo();
    const props = {
      transcript: "",
      currentTurnId: null,
      activeCycleState: "idle" as const,
      currentUser,
    };
    const view = render(<ChatView messages={[message("history")]} {...props} />);
    const scroller = view.container.querySelector<HTMLElement>(".chat-view")!;
    scroller.scrollTop = 240;

    view.rerender(
      <ChatView messages={[message("history")]} status="loading" {...props} />,
    );
    expect(scroller.scrollTop).toBe(240);

    view.rerender(
      <ChatView
        messages={[message("history"), message("reply")]}
        status="ready"
        {...props}
      />,
    );
    const rows = view.container.querySelectorAll<HTMLElement>(
      "[data-message-key]",
    );
    expect(scroller.scrollTop).toBe(240);
    expect(rows[0]?.classList.contains("message-bubble--entering")).toBe(false);
    expect(rows[1]?.classList.contains("message-bubble--entering")).toBe(true);
  });

  it("cancels owned-send frame on unmount", () => {
    const clock = installRafClock();
    const scrollTo = installScrollTo();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const top = this.dataset.pendingId ? 400 : 0;
        return {
          x: 0,
          y: top,
          top,
          right: 0,
          bottom: 0,
          left: 0,
          width: 0,
          height: 0,
          toJSON() {},
        };
      },
    );
    const props = {
      transcript: "",
      currentTurnId: null,
      activeCycleState: "idle" as const,
      currentUser,
    };
    const view = render(<ChatView messages={[message("history")]} {...props} />);
    const scroller = view.container.querySelector<HTMLElement>(".chat-view")!;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scroller.scrollTop = 100;
    scrollTo.mockClear();
    view.rerender(
      <ChatView
        messages={[message("history"), message("local", "pending-local")]}
        localSendIds={["pending-local"]}
        {...props}
      />,
    );
    expect(clock.pending()).toBe(1);

    view.unmount();
    expect(clock.pending()).toBe(0);
    clock.advance(250);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not replay entrance when assistant projection keeps its first-visible id", () => {
    const placeholder: ChatMessage = {
      id: "inflight-t1",
      role: "assistant",
      text: "",
      timestamp: 100,
      isStreaming: true,
      turnId: "t1",
    };
    const view = render(
      <ChatView
        messages={[]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    view.rerender(
      <ChatView
        messages={[placeholder]}
        transcript=""
        currentTurnId="t1"
        activeCycleState="thinking"
        currentUser={currentUser}
      />,
    );
    const row =
      view.container.querySelector<HTMLElement>("[data-message-key]")!;
    expect(row.classList.contains("message-bubble--entering")).toBe(true);
    row.dispatchEvent(new Event("animationend"));

    const firstDelta = { ...placeholder, replyId: "m1", text: "Hello" };
    view.rerender(
      <ChatView
        messages={[firstDelta]}
        transcript=""
        currentTurnId="t1"
        activeCycleState="thinking"
        currentUser={currentUser}
      />,
    );
    expect(view.container.querySelector("[data-message-key]")).toBe(row);
    expect(row.classList.contains("message-bubble--entering")).toBe(false);

    view.rerender(
      <ChatView
        messages={[{ ...firstDelta, text: "Hello there", isStreaming: false }]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(view.container.querySelector("[data-message-key]")).toBe(row);
    expect(row.classList.contains("message-bubble--entering")).toBe(false);
  });

  it("keeps first explicit send at top and removes travel under Reduced Motion", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const view = render(
      <ChatView
        messages={[]}
        localSendIds={[]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    scrollTo.mockClear();
    view.rerender(
      <ChatView
        messages={[message("first", "pending-first")]}
        localSendIds={["pending-first"]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("does not anchor hydrated history or indistinguishable remote user rows", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const view = render(
      <ChatView
        messages={[message("history", "old-local")]}
        localSendIds={["old-local"]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
    view.rerender(
      <ChatView
        messages={[message("history"), message("remote")]}
        localSendIds={["some-other-send"]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={currentUser}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
