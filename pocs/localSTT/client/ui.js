// DOM rendering helpers for the localSTT PoC client.
//
// No innerHTML anywhere — every element is constructed via
// `document.createElement` + `textContent`, so content arriving over the
// WebSocket can never cause XSS even if the server is compromised.

// ---------------------------------------------------------------------------
// Safe element builder
// ---------------------------------------------------------------------------

export function el(tag, opts) {
  const node = document.createElement(tag);
  if (!opts) return node;
  if (opts.className) node.className = opts.className;
  if (opts.textContent != null) node.textContent = String(opts.textContent);
  if (opts.dataset) {
    for (const k of Object.keys(opts.dataset)) node.dataset[k] = String(opts.dataset[k]);
  }
  if (opts.attrs) {
    for (const k of Object.keys(opts.attrs)) node.setAttribute(k, String(opts.attrs[k]));
  }
  return node;
}

function tagPill(text, variant) {
  return el("span", { className: `tag ${variant || ""}`.trim(), textContent: text });
}

// ---------------------------------------------------------------------------
// SenseVoice tag helpers
// ---------------------------------------------------------------------------

/**
 * Strip SenseVoice tag tokens from *body* text. Use this for the
 * transcript `text` field, where stray tags shouldn't render to the user.
 *   stripTags("hello <|Speech|> world")  →  "hello  world"
 */
export function stripTags(raw) {
  return (raw || "").replace(/<\|[^|]*\|>/g, "").trim();
}

/**
 * Extract the content of a single SenseVoice tag token. Use this for the
 * `language`, `emotion`, and `event` metadata fields which arrive
 * wrapped in the tag syntax.
 *   extractTagContent("<|zh|>")       →  "zh"
 *   extractTagContent("<|NEUTRAL|>")  →  "NEUTRAL"
 *   extractTagContent("")             →  ""
 *   extractTagContent("zh")           →  "zh"  (already unwrapped)
 */
export function extractTagContent(raw) {
  if (!raw) return "";
  const m = String(raw).match(/<\|([^|]*)\|>/);
  return m ? m[1].trim() : String(raw).trim();
}

// ---------------------------------------------------------------------------
// Cached element handles
// ---------------------------------------------------------------------------

export const els = {
  url: document.getElementById("url"),
  token: document.getElementById("token"),
  connect: document.getElementById("connect"),
  disconnect: document.getElementById("disconnect"),
  connStatus: document.getElementById("conn-status"),
  startMic: document.getElementById("start-mic"),
  stopMic: document.getElementById("stop-mic"),
  micStatus: document.getElementById("mic-status"),
  bytesSent: document.getElementById("bytes-sent"),
  log: document.getElementById("log"),
  turns: document.getElementById("turns"),
};

// ---------------------------------------------------------------------------
// Status pills + log line
// ---------------------------------------------------------------------------

export function setConnStatus(text, cls) {
  els.connStatus.textContent = text;
  els.connStatus.className = `status ${cls || ""}`.trim();
}

export function setMicStatus(text, cls) {
  els.micStatus.textContent = text;
  els.micStatus.className = `status ${cls || ""}`.trim();
}

export function appendLog(kind, message) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = el("div", {
    className: `log-line log-${kind}`,
    textContent: `${ts}  ${message}`,
  });
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

export function updateBytesSent(total) {
  els.bytesSent.textContent = `${total.toLocaleString()} B sent`;
}

// ---------------------------------------------------------------------------
// Turn card lifecycle
// ---------------------------------------------------------------------------

export function addTurnCard(meta, wavBlob) {
  const li = el("li", { dataset: { turnIdx: meta.turnIdx } });

  const header = el("div", { className: "turn-header" });
  const headerLeft = el("div");
  headerLeft.appendChild(
    el("span", { className: "turn-idx", textContent: `Turn ${meta.turnIdx}` }),
  );
  headerLeft.appendChild(
    el("span", {
      attrs: { style: "margin-left: 10px;" },
      textContent: `${(meta.durationMs / 1000).toFixed(2)}s · p=${meta.smartTurnProbability}`,
    }),
  );
  const headerTags = el("div", { className: "turn-tags" });
  header.appendChild(headerLeft);
  header.appendChild(headerTags);

  const transcript = el("div", {
    className: "turn-transcript pending",
    textContent: "transcribing…",
  });

  const actions = el("div", { className: "turn-actions" });
  const audio = el("audio");
  audio.controls = true;
  audio.src = URL.createObjectURL(wavBlob);
  const link = el("a", { textContent: "download" });
  link.href = audio.src;
  link.download = `turn_${String(meta.turnIdx).padStart(3, "0")}.wav`;
  actions.appendChild(audio);
  actions.appendChild(link);

  li.appendChild(header);
  li.appendChild(transcript);
  li.appendChild(actions);
  els.turns.insertBefore(li, els.turns.firstChild);
}

/**
 * Inline-render [pause.N] placeholders in the transcript text using a
 * simple debug-friendly format. This is NOT the format the LLM sees —
 * the gateway does a language-aware substitution before calling the LLM.
 * Here we just want the human watching the PoC to see durations inline.
 */
function expandPausePlaceholders(text, pauses) {
  return text.replace(/\[pause\.(\d+)\]/g, (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= pauses.length) return "[pause.?]";
    const seconds = (pauses[idx] / 1000).toFixed(1);
    return `⏸${seconds}s`;
  });
}

export function fillTranscript(msg) {
  const li = els.turns.querySelector(`li[data-turn-idx="${msg.turnIdx}"]`);
  if (!li) {
    appendLog("error", `transcript for unknown turn ${msg.turnIdx}`);
    return;
  }
  const transcript = li.querySelector(".turn-transcript");
  const tagHost = li.querySelector(".turn-tags");
  const pauses = msg.pauses || [];
  const rawText = stripTags(msg.text) || "(no speech detected)";
  transcript.textContent = expandPausePlaceholders(rawText, pauses);
  transcript.classList.remove("pending");

  while (tagHost.firstChild) tagHost.removeChild(tagHost.firstChild);

  // Emotion + event arrive wrapped as <|xxx|>. Always render them (even
  // NEUTRAL / Speech) so the PoC UI makes it obvious what's being
  // detected; dim styling for "boring" values.
  const emo = extractTagContent(msg.emotion);
  const evt = extractTagContent(msg.event);
  if (emo) {
    const variant = emo === "NEUTRAL" ? "emotion muted" : "emotion";
    tagHost.appendChild(tagPill(emo.toLowerCase(), variant));
  }
  if (evt) {
    const variant = evt === "Speech" ? "event muted" : "event";
    tagHost.appendChild(tagPill(evt.toLowerCase(), variant));
  }
  tagHost.appendChild(tagPill(`${msg.decodeMs} ms`));

  renderPauses(li, pauses);
}

/**
 * Render the pause summary row beneath the transcript.
 *
 *   ⏸ 3 pauses   [0] 1.2s   [1] 0.9s   [2] 1.5s
 *
 * The indices match the ``[pause.N]`` tokens in the raw transcript, so
 * you can visually connect each chip to its placeholder in the text.
 */
function renderPauses(li, pauses) {
  const existing = li.querySelector(".turn-pauses");
  if (existing) existing.remove();

  if (!pauses || pauses.length === 0) return;

  const row = el("div", { className: "turn-pauses" });
  row.appendChild(
    el("span", {
      className: "turn-pauses-label",
      textContent: `⏸ ${pauses.length} pause${pauses.length === 1 ? "" : "s"}`,
    }),
  );

  pauses.forEach((durationMs, i) => {
    const seconds = (durationMs / 1000).toFixed(1);
    const variant = durationMs >= 1500 ? "long" : durationMs >= 500 ? "medium" : "short";
    row.appendChild(
      el("span", {
        className: `pause-chip pause-${variant}`,
        textContent: `[${i}] ${seconds}s`,
      }),
    );
  });

  const transcriptEl = li.querySelector(".turn-transcript");
  transcriptEl.insertAdjacentElement("afterend", row);
}
