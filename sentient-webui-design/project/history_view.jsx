// Past chats — left-side drawer mirroring the Workspace pattern.
// Calm, glanceable list grouped by recency. Same visual vocabulary as the
// rest of Sentient: Fraunces title, terra accents, friendly cards.

const INITIAL_HISTORY = [
  { group: "Today", items: [
    { id: "c1", title: "Get me some news for today",   time: "9:42 AM", preview: "Here are today's headlines for you…" },
    { id: "c2", title: "Philosophical discussion",     time: "8:15 AM", preview: "On consciousness and being…" },
  ]},
  { group: "Yesterday", items: [
    { id: "c3", title: "Plan Mia's birthday party",    time: "6:21 PM", preview: "We have 8 friends coming on Saturday…" },
    { id: "c4", title: "Reorder grocery list",         time: "4:03 PM", preview: "Updated Tuesday's list — 12 things…" },
  ]},
  { group: "Earlier this week", items: [
    { id: "c5", title: "Lasagna recipe — adapt for Mia", time: "Mon",  preview: "Without eggs, smaller portions…" },
    { id: "c6", title: "Doorbell — who was at 3pm",      time: "Mon",  preview: "It was Jordan from across the street…" },
    { id: "c7", title: "Set Sunday morning routine",     time: "Sun",  preview: "Lights at 7am, kettle, soft music…" },
  ]},
  { group: "Older", items: [
    { id: "c8", title: "October budget review",         time: "3 wks", preview: "Eating out is over, groceries on track…" },
    { id: "c9", title: "Field trip permission slip",    time: "1 mo",  preview: "Drafted and sent to David…" },
  ]},
];

// ---- Tiny popover menu — same visual vocabulary as cards ----
const ItemMenu = ({ onRename, onDelete, onClose }) => {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    // attach next tick so the click that opened the menu doesn't immediately close it
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  return (
    <div className="hx-menu" ref={ref} role="menu">
      <button className="hx-menu-i" role="menuitem" onClick={onRename}>
        <Icon name="edit" size={15}/>
        <span>Rename</span>
      </button>
      <button className="hx-menu-i danger" role="menuitem" onClick={onDelete}>
        <Icon name="trash" size={15}/>
        <span>Delete</span>
      </button>
    </div>
  );
};

// ---- Rename modal ----
const RenameDialog = ({ chat, onCancel, onSave }) => {
  const [v, setV] = React.useState(chat.title);
  const inputRef = React.useRef(null);
  const dirty = v.trim().length > 0 && v.trim() !== chat.title;

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = (e) => { e.preventDefault(); if (dirty) onSave(v.trim()); };

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <form className="modal hx-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="modal-h">
          <h3>Rename chat</h3>
          <button type="button" className="modal-x" onClick={onCancel} aria-label="Close">
            <Icon name="x" size={14}/>
          </button>
        </header>
        <div className="modal-b">
          <label className="hx-field">
            <span className="hx-field-l">Title</span>
            <input
              ref={inputRef}
              className="hx-input"
              type="text"
              value={v}
              onChange={(e) => setV(e.target.value)}
              maxLength={120}
            />
          </label>
          <p className="hx-hint">{dirty ? "Press Save to update." : "Edit the title to enable Save."}</p>
        </div>
        <footer className="modal-f hx-modal-f">
          <button type="button" className="btn b-md b-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn b-md b-primary on-dark" disabled={!dirty}>Save</button>
        </footer>
      </form>
    </div>
  );
};

// ---- Delete confirm modal ----
const DeleteDialog = ({ chat, onCancel, onConfirm }) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal hx-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-h">
          <h3>Delete chat?</h3>
          <button className="modal-x" onClick={onCancel} aria-label="Close">
            <Icon name="x" size={14}/>
          </button>
        </header>
        <div className="modal-b">
          <p className="hx-lead">This permanently removes the conversation, including its messages. This can't be undone.</p>
          <div className="hx-readonly">
            <span className="hx-field-l">Chat</span>
            <span className="hx-readonly-v">{chat.title}</span>
          </div>
        </div>
        <footer className="modal-f hx-modal-f">
          <button className="btn b-md b-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn b-md hx-danger-btn" onClick={onConfirm}>
            <Icon name="trash" size={14}/>
            <span>Delete</span>
          </button>
        </footer>
      </div>
    </div>
  );
};

const HistoryDrawer = ({ open, onClose, currentId = "c1", onSelect }) => {
  const [q, setQ] = React.useState("");
  const [groups, setGroups] = React.useState(INITIAL_HISTORY);
  const [menuFor, setMenuFor] = React.useState(null); // chat id with open menu
  const [renaming, setRenaming] = React.useState(null);
  const [deleting, setDeleting] = React.useState(null);

  // Expose for the LLM tool call — agent can drive the same UI
  React.useEffect(() => {
    window.sentient = window.sentient || {};
    window.sentient.openHistory = () => onClose && onClose(false);
  }, [onClose]);

  // Close menu whenever the drawer closes
  React.useEffect(() => { if (!open) setMenuFor(null); }, [open]);

  const filtered = q
    ? groups
        .map(g => ({ ...g, items: g.items.filter(it =>
          (it.title + " " + it.preview).toLowerCase().includes(q.toLowerCase())) }))
        .filter(g => g.items.length > 0)
    : groups;

  const findChat = (id) => {
    for (const g of groups) for (const it of g.items) if (it.id === id) return it;
    return null;
  };

  const updateTitle = (id, title) => {
    setGroups(gs => gs.map(g => ({ ...g, items: g.items.map(it => it.id === id ? { ...it, title } : it) })));
  };
  const removeChat = (id) => {
    setGroups(gs => gs.map(g => ({ ...g, items: g.items.filter(it => it.id !== id) })).filter(g => g.items.length > 0));
  };

  return (
    <>
      <div className={`hx-backdrop ${open ? "show" : ""}`} onClick={onClose}/>
      <aside className={`hx-drawer ${open ? "show" : ""}`} aria-hidden={!open}>
        <header className="hx-head">
          <div className="hx-head-titles">
            <h2 className="hx-title">Past chats</h2>
            <p className="hx-subtitle">Pick up where you left off</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={18}/>
          </button>
        </header>

        <div className="hx-search">
          <Icon name="search" size={14}/>
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search past chats"
          />
          {q && (
            <button className="hx-search-clear" onClick={() => setQ("")} title="Clear">
              <Icon name="x" size={12}/>
            </button>
          )}
        </div>

        <div className="hx-body">
          {filtered.length === 0 ? (
            <div className="hx-empty">
              <Icon name="search" size={28}/>
              <p>Nothing matched "{q}"</p>
            </div>
          ) : (
            filtered.map((group, gi) => (
              <section key={gi} className="hx-group">
                <h3 className="hx-group-label">{group.group}</h3>
                <ul className="hx-list">
                  {group.items.map(item => {
                    const isActive = item.id === currentId;
                    const isOpen = menuFor === item.id;
                    return (
                      <li key={item.id} className={`hx-row ${isOpen ? "menu-open" : ""}`}>
                        <button
                          className={`hx-item ${isActive ? "active" : ""}`}
                          onClick={() => onSelect && onSelect(item.id)}>
                          <span className="hx-item-body">
                            <span className="hx-item-title">{item.title}</span>
                            <span className="hx-item-preview">{item.preview}</span>
                          </span>
                          <span className="hx-item-time">{item.time}</span>
                        </button>
                        <button
                          className={`hx-more ${isOpen ? "open" : ""}`}
                          aria-label="More actions"
                          aria-haspopup="menu"
                          aria-expanded={isOpen}
                          onClick={(e) => { e.stopPropagation(); setMenuFor(isOpen ? null : item.id); }}>
                          <Icon name="dots-h" size={16}/>
                        </button>
                        {isOpen && (
                          <ItemMenu
                            onClose={() => setMenuFor(null)}
                            onRename={() => { setMenuFor(null); setRenaming(item.id); }}
                            onDelete={() => { setMenuFor(null); setDeleting(item.id); }}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <footer className="hx-foot">
          <button className="hx-newchat">
            <Icon name="plus" size={15}/>
            <span>New chat</span>
          </button>
        </footer>
      </aside>

      {renaming && (
        <RenameDialog
          chat={findChat(renaming)}
          onCancel={() => setRenaming(null)}
          onSave={(t) => { updateTitle(renaming, t); setRenaming(null); }}
        />
      )}
      {deleting && (
        <DeleteDialog
          chat={findChat(deleting)}
          onCancel={() => setDeleting(null)}
          onConfirm={() => { removeChat(deleting); setDeleting(null); }}
        />
      )}
    </>
  );
};

window.HistoryDrawer = HistoryDrawer;
