/** Isolated loopback production-leaf probe. No app, transport, audio or auth. */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { MessageBubble } from "../components/chat/message-bubble.tsx";
import { MessageContent } from "../components/chat/message-content.tsx";
import { R0_MARKDOWN, R0_TABLE_MARKDOWN } from "./rich-message-fixture.ts";
import "../styles/tokens/design-foundation-v2.css";
import "../styles/tokens/compatibility.css";
import "../components/common/foundation.css";
import "../components/chat/chat-messages.css";

if (!import.meta.env.DEV || !["127.0.0.1", "localhost"].includes(location.hostname)) {
  throw new Error("Rich-message fixture requires loopback development server");
}

function Fixture() {
  const [suffix, setSuffix] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [media, setMedia] = useState(false);
  const [url, setUrl] = useState("");
  useEffect(() => {
    // Public synthetic PNG, owned/revoked exactly like production preview assets.
    const bytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="),
      (byte) => byte.charCodeAt(0),
    );
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    setUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, []);
  const currentUser = { displayName: "Fixture person", avatarTint: "terra" as const };
  const attachmentId = "att_0123456789abcdef0123456789abcdef";
  const inlineMedia = media ? `\n\n![Public inline preview](/api/v1/attachments/${attachmentId}/preview)` : "";
  return (
    <main
      style={{
        padding: "24px",
        maxWidth: "840px",
        margin: "auto",
        color: "var(--color-ink)",
        background: "var(--color-bg)",
      }}
    >
      <h1>Rich-message isolated fixture</h1>
      <nav
        style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "32px" }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <button type="button" onClick={() => setSuffix((previous) => `${previous}new **content`)}>
          Append stream
        </button>
        <button
          type="button"
          onClick={() => {
            setSuffix((previous) => `${previous}**`);
            setStreaming(false);
          }}
        >
          Finalize
        </button>
        <button type="button" onClick={() => setMedia((previous) => !previous)}>
          Toggle image arrival
        </button>
        <button
          type="button"
          onClick={() => {
            const expired = URL.createObjectURL(new Blob(["unavailable"], { type: "image/png" }));
            URL.revokeObjectURL(expired);
            setUrl(expired);
          }}
        >
          Expire preview
        </button>
        <button
          type="button"
          onClick={() => {
            setSuffix("");
            setStreaming(true);
          }}
        >
          Reset stream
        </button>
      </nav>
      <div class="message-list">
        <MessageBubble
          message={{
            id: "r0",
            role: "assistant",
            text: R0_MARKDOWN + suffix + inlineMedia,
            isStreaming: streaming,
            timestamp: 0,
            attachments: media
              ? [
                  {
                    kind: "remote",
                    ref: {
                      attachmentId,
                      displayName: "Public preview.png",
                      contentType: "image/png",
                      mediaKind: "image",
                      size: 68,
                    },
                  },
                ]
              : [],
          }}
          attachmentAssets={{ [attachmentId]: { previewUrl: url } }}
          identityState="idle"
          currentUser={currentUser}
          continuation
        />
        <MessageBubble
          message={{
            id: "other",
            role: "user",
            text: "Other message must never join this selection.",
            isStreaming: false,
            timestamp: 0,
          }}
          identityState="idle"
          currentUser={currentUser}
        />
        <section aria-label="Authorized media arrival" style={{ maxWidth: "520px" }}>
          <MessageContent
            text="![Public fixture preview](/api/v1/attachments/att_fixture/preview)"
            isStreaming={false}
            images={media ? new Map([["/api/v1/attachments/att_fixture/preview", url]]) : undefined}
          />
        </section>
        <section aria-label="Untrusted content probe">
          <MessageContent
            text={
              'Blocked image: ![Tracker](https://tracker.invalid/pixel)\n\n<script>window.fixtureXss = true</script>\n\n<a href="javascript:alert(1)" onclick="window.fixtureXss = true">Unsafe link</a>\n\n<img src="//tracker.invalid/pixel" onerror="window.fixtureXss = true" alt="Raw tracker" />'
            }
            isStreaming={false}
          />
        </section>
        <MessageBubble
          message={{ id: "table-only", role: "assistant", text: R0_TABLE_MARKDOWN, isStreaming: false, timestamp: 0 }}
          identityState="idle"
          currentUser={currentUser}
          continuation
        />
        <section aria-label="Syntax mutation probe">
          <MessageContent text={suffix ? "Start **word**" : "Start **word"} isStreaming={streaming} />
        </section>
      </div>
    </main>
  );
}
const root = document.getElementById("app");
if (!root) throw new Error("Missing fixture root");
render(<Fixture />, root);
