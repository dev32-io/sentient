// Reusable chat components

// Inline voice status that lives in the message meta row
const VoiceInline = ({ state = "played", duration = "0:08" }) => {
  if (state === "none" || state === "speaking" || state === "interrupted") return null;
  const label = `Spoken · ${duration}`;
  return (
    <span className={`v-inline ${state}`}>
      <span className="v-wave">
        <i/><i/><i/><i/><i/>
      </span>
      <span>{label}</span>
      <button className="v-replay" title="Replay voice">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 3l14 9-14 9V3z"/>
        </svg>
      </button>
    </span>
  );
};

// Kept for back-compat / legacy calls — renders nothing now
const VoiceTag = () => null;

const ToolStatus = ({ status }) => {
  if (status === "ok") return <span className="t-status ok"><span className="ok-dot"/>Done</span>;
  if (status === "run") return <span className="t-status run"><span className="spin"/>Running</span>;
  if (status === "err") return <span className="t-status err"><span className="ok-dot"/>Failed</span>;
  return <span className="t-status">Queued</span>;
};

const ToolCard = ({ icon, name, args, status, subtitle, children, expanded }) => (
  <div className="tool-card">
    <div className="t-icon"><Icon name={icon} size={16}/></div>
    <div className="t-meta">
      <div className="t-title">
        <code>{name}</code>
      </div>
      <div className="t-sub">{subtitle}</div>
    </div>
    <ToolStatus status={status}/>
    {expanded && children && <div className="tool-result">{children}</div>}
  </div>
);

const ToolsBlock = ({ tools }) => {
  const [openIdx, setOpenIdx] = React.useState(null);
  const openTool = openIdx !== null ? tools[openIdx] : null;
  return (
    <div className="tools">
      <div className="tools-strip">
        {tools.map((t, i) => {
          const isOpen = openIdx === i;
          const canExpand = !!t.result || !!t.subtitle;
          return (
            <button
              key={i}
              className={`pill ${t.status} ${isOpen ? "open" : ""}`}
              onClick={() => canExpand && setOpenIdx(isOpen ? null : i)}>
              <span className="pill-icon"><Icon name={t.icon} size={14}/></span>
              <code>{t.name}</code>
              <span className="s-dot"/>
              {canExpand && (
                <span className="pill-chev"><Icon name="chevron" size={10}/></span>
              )}
            </button>
          );
        })}
      </div>
      {openTool && (
        <div className="tool-inline">
          <div className="t-sub-line">{openTool.subtitle}</div>
          {openTool.result && <div className="tool-result">{openTool.result}</div>}
        </div>
      )}
    </div>
  );
};

const Message = ({ role, name, time, avatarChar, voice, children }) => (
  <div className={`msg ${role} ${voice ? `voice-${voice.state}` : ""}`}>
    <div className="who">
      {avatarChar}
      {voice?.state === "speaking" && (
        <>
          <span className="who-ripple"/>
          <span className="who-ripple d2"/>
        </>
      )}
    </div>
    <div className="body">
      <div className="meta">
        <span className="name">{name}</span>
        <span className="meta-sep">·</span>
        <span>{time}</span>
      </div>
      {children}
    </div>
  </div>
);

window.VoiceInline = VoiceInline;
window.VoiceTag = VoiceTag;
window.ToolStatus = ToolStatus;
window.ToolCard = ToolCard;
window.ToolsBlock = ToolsBlock;
window.Message = Message;
