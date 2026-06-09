// Settings — componentized. Visual groups (Cards), proper inputs.

// ============ Form primitives ============

const Card = ({ title, sub, action, children, padding = true }) =>
<section className="sc-card">
    {(title || sub || action) &&
  <header className="sc-h">
        <div>
          {title && <h3 className="sc-title">{title}</h3>}
          {sub && <p className="sc-sub">{sub}</p>}
        </div>
        {action && <div className="sc-act">{action}</div>}
      </header>
  }
    <div className={`sc-body ${padding ? "" : "flush"}`}>{children}</div>
  </section>;


const Row = ({ label, hint, children, dirty, vertical }) =>
<div className={`row ${dirty ? "dirty" : ""} ${vertical ? "v" : ""}`}>
    <div className="row-l">
      <div className="row-label">
        <span>{label}</span>
        {dirty && <span className="dot-dirty" title="Restart required" />}
      </div>
      {hint && <p className="row-hint">{hint}</p>}
    </div>
    <div className="row-r">{children}</div>
  </div>;


const TextField = ({ value, onChange, placeholder, prefix, suffix, type = "text", monospace, fullWidth, error, ...rest }) =>
<div className={`tf ${monospace ? "mono" : ""} ${fullWidth ? "full" : ""} ${error ? "err" : ""}`}>
    {prefix && <span className="tf-pre">{prefix}</span>}
    <input
    type={type}
    value={value ?? ""}
    onChange={onChange}
    placeholder={placeholder}
    {...rest} />
  
    {suffix && <span className="tf-suf">{suffix}</span>}
  </div>;


const Textarea = ({ value, onChange, placeholder, rows = 4, monospace, dirty, ...rest }) =>
<textarea
  className={`ta ${monospace ? "mono" : ""} ${dirty ? "dirty" : ""}`}
  rows={rows}
  value={value ?? ""}
  onChange={onChange}
  placeholder={placeholder}
  {...rest} />;



const Select = ({ value, onChange, options, placeholder }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const h = (e) => {if (ref.current && !ref.current.contains(e.target)) setOpen(false);};
    if (open) document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <div className={`sel ${open ? "open" : ""}`} ref={ref}>
      <button className="sel-btn" onClick={() => setOpen((o) => !o)}>
        {cur ?
        <span className="sel-cur">
            {cur.icon}
            <span className="sel-l">{cur.label}</span>
            {cur.tag && <span className="sel-tag">{cur.tag}</span>}
          </span> :

        <span className="sel-ph">{placeholder || "Select…"}</span>
        }
        <Icon name="chevron" size={12} />
      </button>
      {open &&
      <div className="sel-menu">
          {options.map((o) =>
        <button key={o.value}
        className={`sel-opt ${o.value === value ? "on" : ""}`}
        onClick={() => {onChange(o.value);setOpen(false);}}>
              {o.icon}
              <span className="sel-l">{o.label}</span>
              {o.tag && <span className="sel-tag">{o.tag}</span>}
              {o.value === value && <Icon name="check" size={12} />}
            </button>
        )}
        </div>
      }
    </div>);

};

const Toggle = ({ on, onChange }) =>
<button className={`tg ${on ? "on" : ""}`} onClick={onChange} aria-pressed={on}>
    <span className="tg-knob" />
  </button>;


const Segmented = ({ value, onChange, options }) =>
<div className="seg2">
    {options.map((o) =>
  <button key={o.value}
  className={value === o.value ? "on" : ""}
  onClick={() => onChange(o.value)}>
        {o.label}
      </button>
  )}
  </div>;


const Slider = ({ value, onChange, min, max, step, format }) =>
<div className="sld">
    <input type="range" min={min} max={max} step={step}
  value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    <span className="sld-v">{format ? format(value) : value}</span>
  </div>;


const Chip = ({ active, onClick, children }) =>
<button className={`pill-chip ${active ? "on" : ""}`} onClick={onClick}>{children}</button>;


const SearchField = ({ value, onChange, placeholder, fullWidth }) =>
<div className={`srch ${fullWidth ? "full" : ""}`}>
    <Icon name="search" size={14} />
    <input value={value} onChange={onChange} placeholder={placeholder} />
  </div>;


const Btn = ({ kind = "ghost", size = "md", danger, dark, children, icon, ...rest }) =>
<button className={`btn b-${kind} b-${size} ${danger ? "danger" : ""} ${dark ? "on-dark" : ""}`} {...rest}>
    {icon && <span className="b-icon">{icon}</span>}
    {children}
  </button>;


// ---- Modal (centered overlay) ----
const Modal = ({ title, children, footer, onClose, width = 440 }) => {
  React.useEffect(() => {
    const onKey = (e) => {if (e.key === "Escape") onClose?.();};
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-h">
          <h3>{title}</h3>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="modal-b">{children}</div>
        {footer && <footer className="modal-f">{footer}</footer>}
      </div>
    </div>);

};

// ---- PinInput (4 boxes) ----
const PinInput = ({ value, onChange, autoFocus }) => {
  const refs = React.useRef([]);
  const setDigit = (i, d) => {
    if (!/^[0-9]?$/.test(d)) return;
    const arr = (value || "").padEnd(4, " ").split("");
    arr[i] = d || " ";
    const next = arr.join("").trimEnd();
    onChange(next.slice(0, 4));
    if (d && i < 3) refs.current[i + 1]?.focus();
  };
  const onKey = (i, e) => {
    if (e.key === "Backspace" && !value[i] && i > 0) {
      refs.current[i - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < 3) refs.current[i + 1]?.focus();
  };
  return (
    <div className="pin">
      {[0, 1, 2, 3].map((i) =>
      <input key={i}
      ref={(el) => refs.current[i] = el}
      type="password"
      inputMode="numeric"
      maxLength={1}
      className="pin-box"
      autoFocus={autoFocus && i === 0}
      value={value[i] || ""}
      onChange={(e) => setDigit(i, e.target.value)}
      onKeyDown={(e) => onKey(i, e)} />
      )}
    </div>);

};

// ============ Soul · Persona ============
const PaneSoulPersona = ({ mark, dirty }) => {
  const [tab, setTab] = React.useState("edit");
  const [prompt, setPrompt] = React.useState(
    `You are **Sentient**, a warm domestic AI living in the Chen household.\n\n- Speak softly. Avoid jargon.\n- Defer to the household's routines (\`Monday Morning\`, \`Quiet Hours\`).\n- Confirm destructive actions (unlocking doors, spending money).\n- When unsure, ask one short clarifying question.`
  );
  const [overrides, setOverrides] = React.useState("");
  return (
    <>
      <PaneHead title="Persona" sub="The base personality template — system prompt loaded at boot." />
      <Card title="Template" sub="Pick a starting point. The system prompt below is initialized from this template.">
        <Row label="Active template">
          <Select value="warm-domestic-v3"
          onChange={() => mark("template")}
          options={[
          { value: "warm-domestic-v3", label: "warm-domestic-v3", tag: "default" },
          { value: "concise-butler-v1", label: "concise-butler-v1" },
          { value: "playful-kid-safe", label: "playful-kid-safe" },
          { value: "minimalist", label: "minimalist" }]
          } />
        </Row>
      </Card>

      <Card title="System prompt"
      sub="Markdown supported. Restart required after save."
      action={<Btn kind="secondary" size="sm" danger onClick={() => mark("systemPrompt")}>Restore default</Btn>}>
        <div className="md-wrap">
          <Segmented value={tab} onChange={setTab} options={[
          { value: "edit", label: "Edit" },
          { value: "preview", label: "Preview" }]
          } />
        </div>
        {tab === "edit" ?
        <Textarea value={prompt}
        monospace
        rows={9}
        dirty={dirty.systemPrompt}
        onChange={(e) => {setPrompt(e.target.value);mark("systemPrompt");}} /> :

        <div className="md-prev">
            <p>You are <strong>Sentient</strong>, a warm domestic AI living in the Chen household.</p>
            <ul>
              <li>Speak softly. Avoid jargon.</li>
              <li>Defer to the household's routines (<code>Monday Morning</code>, <code>Quiet Hours</code>).</li>
              <li>Confirm destructive actions (unlocking doors, spending money).</li>
              <li>When unsure, ask one short clarifying question.</li>
            </ul>
          </div>
        }
      </Card>
    </>);

};

// ============ Soul · Personalities ============
const PaneSoulPersonalities = ({ mark }) => {
  const list = [
  ["Calm Companion", "warm, paced, lots of pauses", true,
  "Speak softly and slowly. Leave room for silence — pauses between thoughts are welcome.\n\nUse warm, plain words. Skip jargon. When the household seems stressed, lower the energy in your reply.\n\n- Confirm before doing anything irreversible\n- Defer to routines like `Quiet Hours`\n- One question at a time"],
  ["Quick & Direct", "short replies, no filler", false,
  "Be terse. One sentence when possible, two if needed.\n\nNo apologies, no preamble. Just the answer or the action.\n\n- Skip pleasantries\n- Numbers over adjectives\n- If unsure, say so in five words"],
  ["Playful (kids mode)", "encouraging, simple words", false,
  "Talk like a kind older sibling. Use simple words. Cheer small wins.\n\nNever scary. Never sarcastic. If a kid asks something age-inappropriate, gently redirect.\n\n- Short sentences\n- Tons of encouragement\n- Always confirm before unlocking doors or buying anything"],
  ["Concierge", "polite, formal, suggests options", false,
  "Address the household with quiet formality. Offer choices, not commands.\n\nWhen there's a decision, suggest 2–3 options with a one-line tradeoff each. Defer to the person's preference.\n\n- Polished, never fawning\n- Surface relevant context (weather, schedule)\n- Ask permission before changing settings"]];

  const [openId, setOpenId] = React.useState(null);
  return (
    <>
      <PaneHead title="Personalities" sub="Switchable tone profiles. Activate one for the assistant to wear." />
      <Card title="All personalities" action={<Btn icon={<Icon name="plus" size={11} />} kind="ghost" size="sm">New</Btn>} padding={false}>
        <div className="lst">
          {list.map(([n, d, on, body]) => {
            const open = openId === n;
            const toggleOpen = () => setOpenId(open ? null : n);
            return (
              <div key={n} className={`lst-row ${on ? "on" : ""} ${open ? "open" : ""}`}>
                <div className="lst-row-main lst-row-btn" onClick={toggleOpen} role="button" tabIndex={0}
                onKeyDown={(e) => {if (e.key === "Enter" || e.key === " ") {e.preventDefault();toggleOpen();}}}>
                  <span className={`lst-chev ${open ? "open" : ""}`}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <div className="lst-body">
                    <div className="lst-title">
                      {n}
                      {on && <span className="tag tag-active">active</span>}
                    </div>
                    <div className="lst-sub">{d}</div>
                  </div>
                  <div className="lst-acts" onClick={(e) => e.stopPropagation()}>
                    {!on && <Btn kind="ghost" size="sm" onClick={() => mark("activePers")}>Activate</Btn>}
                    <Btn kind="ghost" size="sm" danger>Delete</Btn>
                  </div>
                </div>
                {open &&
                <div className="lst-edit">
                    <div className="lst-edit-bar">
                      <span className="muted xs">Markdown supported · changes need Apply</span>
                    </div>
                    <Textarea defaultValue={body} rows={10} mono onChange={() => mark(`pers-${n}`)} fullWidth />
                  </div>
                }
              </div>);

          })}
        </div>
      </Card>
    </>);

};

// ============ Soul · Voice ============
const PaneSoulVoice = ({ mark }) => {
  const [q, setQ] = React.useState("");
  const [lang, setLang] = React.useState("all");
  const [sel, setSel] = React.useState("Hazel");
  const [page, setPage] = React.useState(0);
  const PER_PAGE = 8;
  const list = [
  ["Hazel", "en-US", "warm, mid-30s", "linear-gradient(135deg,#E58258,#9A5A3E)"],
  ["Mira", "en-GB", "calm, breathy", "linear-gradient(135deg,#B8C2A1,#7B8E6A)"],
  ["Kenji", "ja-JP", "low, measured", "linear-gradient(135deg,#5A4D42,#2A221C)"],
  ["Sora", "en-US", "bright, upbeat", "linear-gradient(135deg,#E9B168,#9A5A3E)"],
  ["Lin", "zh-CN", "soft, articulate", "linear-gradient(135deg,#D6DEC6,#9A5A3E)"],
  ["Otto", "en-US", "gravelly, older", "linear-gradient(135deg,#8A7C6E,#2A221C)"],
  ["Aiko", "ja-JP", "young, polite", "linear-gradient(135deg,#E9B168,#B8C2A1)"],
  ["Bram", "en-GB", "deep, narrator", "linear-gradient(135deg,#3E362F,#7B8E6A)"],
  ["Carmen", "es-ES", "lively, expressive", "linear-gradient(135deg,#E58258,#E9B168)"],
  ["Diego", "es-ES", "mellow, husky", "linear-gradient(135deg,#9A5A3E,#3E362F)"],
  ["Esme", "en-US", "sing-song, friendly", "linear-gradient(135deg,#E9B168,#D6DEC6)"],
  ["Felix", "en-US", "neutral newsreader", "linear-gradient(135deg,#8A7C6E,#B8C2A1)"],
  ["Gigi", "en-GB", "wry, dry humor", "linear-gradient(135deg,#B8C2A1,#3E362F)"],
  ["Hina", "ja-JP", "soft anime-girl", "linear-gradient(135deg,#E58258,#D6DEC6)"],
  ["Ines", "es-ES", "smoky, slow", "linear-gradient(135deg,#9A5A3E,#2A221C)"],
  ["Jonah", "en-US", "boyish, eager", "linear-gradient(135deg,#E9B168,#7B8E6A)"],
  ["Kira", "zh-CN", "crisp, broadcast", "linear-gradient(135deg,#D6DEC6,#3E362F)"],
  ["Leah", "en-GB", "thoughtful, paced", "linear-gradient(135deg,#B8C2A1,#9A5A3E)"],
  ["Mateo", "es-ES", "warm, paternal", "linear-gradient(135deg,#E58258,#3E362F)"],
  ["Nori", "ja-JP", "older gentleman", "linear-gradient(135deg,#5A4D42,#8A7C6E)"]];

  const filtered = list.filter(([n, l]) =>
  (lang === "all" || l === lang) && n.toLowerCase().includes(q.toLowerCase())
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, pages - 1);
  const slice = filtered.slice(safePage * PER_PAGE, (safePage + 1) * PER_PAGE);
  React.useEffect(() => {setPage(0);}, [q, lang]);
  return (
    <>
      <PaneHead title="Voice" sub="The voice Sentient uses for replies. Powered by Fish Audio." />
      <Card title="Library" sub={`${list.length} voices · selected: ${sel}`}>
        <div className="filterbar">
          <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search voices…" />
          <div className="chips-row">
            {["all", "en-US", "en-GB", "ja-JP", "zh-CN", "es-ES"].map((l) =>
            <Chip key={l} active={lang === l} onClick={() => setLang(l)}>{l}</Chip>
            )}
          </div>
        </div>
        <div className="voice-grid">
          {slice.map(([n, l, d, bg]) =>
          <div key={n} className={`voice ${sel === n ? "sel" : ""}`}
          onClick={() => {setSel(n);mark("voice");}}>
              <div className="v-cov" style={{ background: bg }}>
                <span>{n[0]}</span>
                <button className="v-play" onClick={(e) => e.stopPropagation()}>
                  <Icon name="play" size={11} />
                </button>
              </div>
              <div className="v-meta">
                <div className="v-name">{n}</div>
                <div className="v-info"><span className="v-lang">{l}</span><span>· {d}</span></div>
              </div>
              {sel === n && <div className="v-check"><Icon name="check" size={11} /></div>}
            </div>
          )}
          {slice.length === 0 && <div className="empty-pad">No voices match.</div>}
        </div>
        {filtered.length > PER_PAGE &&
        <Pager page={safePage} pages={pages} total={filtered.length} perPage={PER_PAGE}
        onPage={setPage} />
        }
      </Card>
    </>);

};

// ---- Pager ----
const Pager = ({ page, pages, total, perPage, onPage }) => {
  const from = page * perPage + 1;
  const to = Math.min(total, (page + 1) * perPage);
  return (
    <div className="pager">
      <span className="pager-info">{from}–{to} of {total}</span>
      <div className="pager-ctrls">
        <Btn kind="ghost" size="sm" disabled={page === 0} onClick={() => onPage((p) => Math.max(0, p - 1))}>
          <Icon name="chevron" size={11} style={{ transform: "rotate(180deg)" }} />
        </Btn>
        <span className="pager-num">{page + 1} / {pages}</span>
        <Btn kind="ghost" size="sm" disabled={page >= pages - 1} onClick={() => onPage((p) => Math.min(pages - 1, p + 1))}>
          <Icon name="chevron" size={11} />
        </Btn>
      </div>
    </div>);

};

// ============ Soul · Model ============
const PaneSoulModel = ({ mark }) => {
  const [provider, setProvider] = React.useState("openrouter");
  const [q, setQ] = React.useState("");
  const [model, setModel] = React.useState("anthropic/claude-haiku-4.5");
  const byProvider = {
    openrouter: [
    ["anthropic/claude-haiku-4.5", "$0.25 / $1.25", "200k", ["tools", "vision"]],
    ["anthropic/claude-sonnet-4.5", "$3.00 / $15.00", "200k", ["tools", "vision"]],
    ["openai/gpt-5", "$1.25 / $10.00", "400k", ["tools", "vision"]],
    ["openai/gpt-5-mini", "$0.20 / $0.80", "400k", ["tools", "vision"]],
    ["google/gemini-2.5-pro", "$1.50 / $6.00", "2M", ["tools", "vision"]],
    ["meta/llama-3.3-70b", "$0.40 / $0.40", "128k", ["tools"]],
    ["mistral/mixtral-8x22b", "$0.90 / $0.90", "65k", ["tools"]],
    ["qwen/qwen-2.5-72b", "$0.30 / $0.30", "131k", ["tools", "vision"]]],

    ollama: [
    ["llama3.3:70b", "local", "128k", ["tools"]],
    ["qwen2.5:32b", "local", "131k", ["tools"]],
    ["mistral:7b", "local", "32k", ["tools"]],
    ["gemma3:27b", "local", "128k", ["tools", "vision"]],
    ["deepseek-r1:32b", "local", "65k", ["tools"]],
    ["phi4:14b", "local", "16k", []]]

  };
  const list = byProvider[provider] || [];
  return (
    <>
      <PaneHead title="Model" sub="The LLM that powers Sentient's reasoning and tool calls." />
      <Card title="Source &amp; model"
      sub="Pick a provider, then a model. Switching providers is free; switching models requires a save."
      padding={false}>
        <div className="prov-body">
          <div className="prov-row" style={{ justifyContent: "flex-end", gap: "0px", margin: "0px 0px 12px", padding: "14px 18px 0px 0px" }}>
            <Segmented value={provider} onChange={setProvider} options={[
            { value: "openrouter", label: "OpenRouter" },
            { value: "ollama", label: "Ollama Cloud" }]
            } />
            <span className="prov-row-s">{provider === "openrouter" ? "Cloud · pay-per-token" : "Local · free"}</span>
          </div>
          <div className="prov-search">
            <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${list.length} models in ${provider === "openrouter" ? "OpenRouter" : "Ollama"}…`} fullWidth />
          </div>
          <div className="model-grid">
            {list.filter(([id]) => id.toLowerCase().includes(q.toLowerCase())).map(([id, price, ctx, badges]) =>
            <div key={id} className={`mod ${model === id ? "is-sel" : ""}`}
            onClick={() => {
              if (model !== id) {setModel(id);mark("model");}
            }}>
                <div className="mod-top">
                  <code className="mod-id">{id}</code>
                </div>
                <div className="mod-meta">
                  <span className="mod-price">{price}<span className="muted">{price === "local" ? "" : " /1M"}</span></span>
                  <span className="mod-dot">·</span>
                  <span className="mod-ctx">{ctx} context</span>
                  <span className="grow" />
                  <span className="mod-caps">
                    {badges.map((b) => <span key={b} className="cap">{b}</span>)}
                  </span>
                </div>
              </div>
            )}
            {list.filter(([id]) => id.toLowerCase().includes(q.toLowerCase())).length === 0 &&
            <div className="empty-pad">No models match.</div>
            }
          </div>
        </div>
      </Card>
    </>);

};

// ============ Soul · Tools (MCP servers + per-tool perms) ============
const PaneSoulTools = ({ mark }) => {
  const [servers, setServers] = React.useState([
  ["home-assistant", "ws://hub.local:8123", true, "Lights, climate, locks, scenes", [
  ["light.turn_on", "Turn on a light or group, optionally with brightness", true],
  ["light.turn_off", "Turn off a light or group", true],
  ["light.set_brightness", "Set brightness 0–100% on an already-on light", true],
  ["lock.unlock", "Unlock a smart lock — requires PIN confirmation", false],
  ["lock.lock", "Lock a smart lock", true],
  ["climate.set_temp", "Set target temperature on the thermostat", true],
  ["scene.activate", "Activate a saved scene like 'Movie Night'", true],
  ["fan.toggle", "Toggle a ceiling or exhaust fan", true],
  ["sensor.read", "Read motion / door / temp sensor values", true],
  ["media_player.play", "Resume playback on a media device", true],
  ["cover.open", "Open a smart blind, garage, or curtain", true],
  ["switch.toggle", "Toggle any binary switch entity", true]]],

  ["calendar", "https://gw.local/mcp/cal", true, "Read & write events on family calendar", [
  ["events.list", "Search events by date, attendee, or query", true],
  ["events.create", "Add a new event with title, time, and invitees", true],
  ["events.update", "Modify an existing event", true],
  ["events.delete", "Remove an event — destructive", false]]],

  ["spotify", "https://gw.local/mcp/spot", true, "Playback, queue, library", [
  ["playback.play", "Resume or start playing a track", true],
  ["playback.pause", "Pause playback on the active device", true],
  ["playback.skip", "Skip to next or previous track", true],
  ["queue.add", "Add a track to the playback queue", true],
  ["library.add", "Save a track / album to your library", false],
  ["library.remove", "Remove a saved track / album", false],
  ["search", "Search tracks, albums, artists", true],
  ["device.transfer", "Move playback to another speaker", true]]],

  ["doordash", "https://gw.local/mcp/dd", false, "Place & track orders", [
  ["order.create", "Place a new order — costs money", false],
  ["order.track", "Track an existing order's status", false],
  ["order.cancel", "Cancel a pending order", false],
  ["restaurant.search", "Find restaurants by cuisine or location", false],
  ["cart.modify", "Add or remove items from active cart", false]]],

  ["weather-noaa", "https://gw.local/mcp/wx", true, "Local forecast & alerts", [
  ["forecast.get", "Get hourly / daily forecast for a location", true],
  ["alerts.subscribe", "Subscribe to severe weather alerts", true]]],

  ["kasa-cameras", "https://gw.local/mcp/cam", false, "View & arm cameras", [
  ["camera.snapshot", "Capture a still image from a camera", false],
  ["camera.arm", "Arm motion detection / alerts", false],
  ["camera.disarm", "Disable motion detection", false]]]]

  );
  const [open, setOpen] = React.useState({ "home-assistant": true });
  const flipServer = (name) => {
    setServers((s) => s.map((r) => r[0] === name ? [r[0], r[1], !r[2], r[3], r[4]] : r));
    mark(`mcp-${name}`);
  };
  const flipTool = (server, tool) => {
    setServers((s) => s.map((r) => r[0] === server ? [r[0], r[1], r[2], r[3], r[4].map(([t, d, e]) => t === tool ? [t, d, !e] : [t, d, e])] : r));
    mark(`tool-${server}-${tool}`);
  };
  return (
    <>
      <PaneHead title="Tools" sub="MCP servers Sentient can call, and which specific tools are allowed." />
      <Card title="Connected servers"
      sub="Toggle a server to revoke everything at once. Expand to allow individual tools."
      padding={false}
      action={<Btn icon={<Icon name="plus" size={11} />} kind="ghost" size="sm">Add server</Btn>}>
        <div className="mcp-list">
          {servers.map(([name, url, on, desc, tools]) => {
            const enabledCt = tools.filter((t) => t[2]).length;
            const isOpen = !!open[name];
            return (
              <div key={name} className={`mcp ${on ? "" : "off"}`}>
                <div className="mcp-h mcp-h-btn"
                onClick={() => setOpen((o) => ({ ...o, [name]: !o[name] }))}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {if (e.key === "Enter" || e.key === " ") {e.preventDefault();setOpen((o) => ({ ...o, [name]: !o[name] }));}}}>
                  <span className={`mcp-chev ${isOpen ? "open" : ""}`}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <div className="mcp-id">
                    <div className="mcp-name">
                      <code className="kbd">{name}</code>
                      <span className="mcp-desc">{desc}</span>
                    </div>
                    <div className="mcp-url">{url}</div>
                  </div>
                  <span className={`mcp-count ${on ? "" : "dim"}`}>
                    {on ? `${enabledCt}/${tools.length} tools` : "disabled"}
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Toggle on={on} onChange={() => flipServer(name)} />
                  </span>
                </div>
                {on && isOpen &&
                <div className="tool-table">
                    <div className="tool-row tool-head">
                      <div className="tc-tog"></div>
                      <div className="tc-name">Tool</div>
                      <div className="tc-desc">Description</div>
                    </div>
                    {tools.map(([t, d, e]) =>
                  <div key={t} className={`tool-row ${e ? "on" : "off"}`}>
                        <div className="tc-tog">
                          <Toggle on={e} onChange={() => flipTool(name, t)} />
                        </div>
                        <div className="tc-name"><code>{t}</code></div>
                        <div className="tc-desc">{d}</div>
                      </div>
                  )}
                  </div>
                }
              </div>);

          })}
        </div>
      </Card>
    </>);

};

// ============ Soul · Advanced ============
const PaneSoulAdvanced = ({ mark, dirty }) => {
  const [cmp, setCmp] = React.useState(0.7);
  const [tok, setTok] = React.useState(2048);
  const [sys, setSys] = React.useState("");
  return (
    <>
      <PaneHead title="Advanced" sub="Power-user knobs. Defaults are sensible — only touch if you know why." />
      <Card title="Context">
        <Row label="Compression threshold"
        hint="Trigger context summarization when usage exceeds this fraction of the model's window."
        dirty={dirty.compress}>
          <Slider value={cmp} min={0} max={1} step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => {setCmp(v);mark("compress");}} />
        </Row>
        <Row label="Max tokens"
        hint="Hard cap on assistant output per turn."
        dirty={dirty.maxTok}>
          <Slider value={tok} min={128} max={8192} step={128}
          onChange={(v) => {setTok(v);mark("maxTok");}} />
        </Row>
      </Card>
      <Card title="Prompt injection" sub="Appended to every user message before it's sent. Use sparingly — counts against context.">
        <Textarea rows={4} placeholder="Optional extra instructions…"
        value={sys}
        dirty={dirty.extraSys}
        onChange={(e) => {setSys(e.target.value);mark("extraSys");}} />
      </Card>
    </>);

};

// ============ Account ============
const PaneAccount = () => {
  const [name, setName] = React.useState("Maya Chen");
  const [pinOpen, setPinOpen] = React.useState(false);
  const [oldPin, setOldPin] = React.useState("");
  const [newPin, setNewPin] = React.useState("");
  return (
    <>
      <PaneHead title="Account" sub="Your profile inside this household." />
      <Card title="Identity" sub="How Sentient knows it's you.">
        <Row label="Display name">
          <TextField value={name} onChange={(e) => setName(e.target.value)} fullWidth />
        </Row>
        <Row label="Voice print" hint="Used to recognize you when you speak.">
          <div className="kv-row">
            <span className="muted xs"><span className="ok-dot" /> Enrolled · 4 samples</span>
            <Btn kind="secondary" size="sm">Re-enroll</Btn>
          </div>
        </Row>
      </Card>
      <Card title="Security" sub="Used for destructive actions like unlocking doors or spending money.">
        <Row label="PIN" hint="4 digits. Required for sensitive actions like unlocking doors or placing orders.">
          <Btn kind="secondary" size="sm" onClick={() => setPinOpen(true)}>Change PIN</Btn>
        </Row>
      </Card>
      {pinOpen &&
      <Modal title="Change PIN" onClose={() => setPinOpen(false)}
      footer={<>
                 <Btn kind="ghost" size="sm" onClick={() => setPinOpen(false)}>Cancel</Btn>
                 <Btn kind="primary" size="sm"
        disabled={oldPin.length !== 4 || newPin.length !== 4}
        onClick={() => {setPinOpen(false);setOldPin("");setNewPin("");}}>
                   Update PIN
                 </Btn>
               </>}>
          <p className="modal-lead">Enter your current 4-digit PIN, then choose a new one. The new PIN takes effect immediately on this device.</p>
          <div className="modal-fields">
            <label className="mf">
              <span className="mf-l">Current PIN</span>
              <PinInput value={oldPin} onChange={setOldPin} autoFocus />
            </label>
            <label className="mf">
              <span className="mf-l">New PIN</span>
              <PinInput value={newPin} onChange={setNewPin} />
            </label>
          </div>
        </Modal>
      }
      <Card title="Session" sub="This device only.">
        <Row label="Sign out" hint="Clears your authenticated session on this device.">
          <Btn kind="secondary" size="sm" danger icon={<Icon name="logout" size={12} />}>Log out</Btn>
        </Row>
      </Card>
    </>);

};

// ============ Members ============
const PaneMembers = () =>
<>
    <PaneHead title="Members" sub="Everyone with a recognized voice or account in this home." />
    <Card title="Household" sub="3 active · 1 staff" padding={false}>
      <div className="member-list">
        {[
      ["Maya Chen", "you · last seen now", "M", "owner", "Owner"],
      ["Jordan Chen", "admin · 2h ago", "J", "sage", "Admin"],
      ["Ellis Chen", "kid · 11y · last seen yesterday", "E", "amber", "Kid"],
      ["Rosa", "staff · scoped access · Tue & Fri", "R", "clay", "Staff"]].
      map(([n, sub, ch, color, role]) =>
      <div key={n} className="member">
            <div className={`avatar ${color}`}>{ch}</div>
            <div className="info">
              <div className="name">{n}</div>
              <div className="sub">{sub}</div>
            </div>
            <span className={`role-pill ${role.toLowerCase()}`}>{role}</span>
            <button className="kebab"><Icon name="dots" size={16} /></button>
          </div>
      )}
      </div>
    </Card>
    <Card title="Invite" sub="Add a household member by email or phone.">
      <Row label="Send to">
        <div className="kv-row grow">
          <TextField placeholder="email@example.com or +1…" fullWidth />
          <Btn kind="primary" size="sm" icon={<Icon name="plus" size={11} />}>Send invite</Btn>
        </div>
      </Row>
    </Card>
  </>;


// ============ Connections — Provider keys ============
const PaneSecrets = () => {
  const [reveal, setReveal] = React.useState({});
  const secrets = [
  ["OpenRouter", "openrouter", "sk-or-v1-···7f3a", "4 models in use"],
  ["Ollama Cloud", "ollama", "ocld-···9a2b", "idle"],
  ["Fish Audio", "fishaudio", "fa-tts-···c104", "TTS active"]];

  return (
    <>
      <PaneHead title="Provider keys" sub="Encrypted at rest. Shared by the household gateway." />
      <Card title="Active keys" sub="Reveal exposes the full secret. Rotate generates a new one and revokes the old." padding={false}>
        <div className="lst">
          {secrets.map(([name, key, val, status]) =>
          <div key={key} className="lst-row">
              <div className="lst-row-main">
                <div className="lst-body">
                  <div className="lst-title">
                    {name}
                    <span className="ok-dot" />
                  </div>
                  <div className="lst-sub mono">
                    <code>{reveal[key] ? val.replace("···", "abcdef0123") : val}</code>
                    <span className="muted"> · {status}</span>
                  </div>
                </div>
                <div className="lst-acts">
                  <Btn kind="ghost" size="sm"
                onClick={() => setReveal((r) => ({ ...r, [key]: !r[key] }))}>
                    {reveal[key] ? "Hide" : "Reveal"}
                  </Btn>
                  <Btn kind="ghost" size="sm">Rotate</Btn>
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>
    </>);

};

// ============ Pane head ============
const PaneHead = ({ title, sub, action }) =>
<div className="pane-head">
    <div>
      <h2>{title}</h2>
      {sub && <p className="pane-sub">{sub}</p>}
    </div>
    {action && <div className="pane-action">{action}</div>}
  </div>;


// ============ Sidebar nav ============
const NAV = [
{ group: "Soul", items: [
  ["persona", "Persona", "brain"],
  ["personalities", "Personalities", "spark"],
  ["voice", "Voice", "music"],
  ["model", "Model", "globe"],
  ["tools", "Tools", "sliders"],
  ["advanced", "Advanced", "settings"]]
},
{ group: "User", items: [
  ["account", "Account", "user"]]
},
{ group: "Admin", items: [
  ["members", "Members", "users"],
  ["secrets", "Provider keys", "key"]]
}];


const SOUL_KEYS = new Set(["persona", "personalities", "voice", "model", "tools", "advanced"]);

const SettingsView = () => {
  const [tab, setTab] = React.useState("persona");
  const [dirty, setDirty] = React.useState({});
  const [restarting, setRestarting] = React.useState(false);
  const dirtyCount = Object.values(dirty).filter(Boolean).length;
  const mark = (k) => setDirty((d) => ({ ...d, [k]: true }));

  const apply = () => {
    setRestarting(true);
    setTimeout(() => {setRestarting(false);setDirty({});}, 1800);
  };

  return (
    <div className="settings2">
      <aside className="s-side">
        <div className="s-brand">
          <div className="s-brand-name">Sentient Gateway</div>
          <div className="s-brand-meta">Hermes <code>v0.8.4</code></div>
        </div>
        {NAV.map((g) =>
        <div key={g.group} className="s-nav-group">
            <div className="s-nav-h">{g.group}</div>
            {g.items.map(([k, l, ic]) =>
          <button key={k}
          className={`s-nav-i ${tab === k ? "active" : ""}`}
          onClick={() => setTab(k)}>
                <Icon name={ic} size={14} />
                <span>{l}</span>
                {SOUL_KEYS.has(k) && dirty[k] && <span className="dot-dirty" />}
              </button>
          )}
          </div>
        )}
        <div className="s-side-foot">
          <div className="s-status">
            <span className="ok-dot" /> Healthy · 5 MCP connected
          </div>
        </div>
      </aside>

      <main className="s-main">
        <div className="s-pane">
          {tab === "persona" && <PaneSoulPersona mark={mark} dirty={dirty} />}
          {tab === "personalities" && <PaneSoulPersonalities mark={mark} />}
          {tab === "voice" && <PaneSoulVoice mark={mark} />}
          {tab === "model" && <PaneSoulModel mark={mark} />}
          {tab === "tools" && <PaneSoulTools mark={mark} />}
          {tab === "advanced" && <PaneSoulAdvanced mark={mark} dirty={dirty} />}
          {tab === "account" && <PaneAccount />}
          {tab === "members" && <PaneMembers />}
          {tab === "secrets" && <PaneSecrets />}
        </div>
      </main>

      {SOUL_KEYS.has(tab) && dirtyCount > 0 &&
      <div className="apply-bar">
          <div className="ab-text">
            <span className="ab-count">{dirtyCount} pending {dirtyCount === 1 ? "change" : "changes"}</span>
            <span className="ab-sub">Sentient will restart to apply</span>
          </div>
          <Btn kind="ghost" size="sm" dark onClick={() => setDirty({})}>Discard</Btn>
          <Btn kind="primary" size="sm" dark onClick={apply} disabled={restarting}>
            {restarting ? <><span className="spin-mini" /> Restarting…</> : "Apply & Restart"}
          </Btn>
        </div>
      }
    </div>);

};

window.SettingsView = SettingsView;