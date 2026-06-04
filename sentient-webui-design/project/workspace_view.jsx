// Workspace — a calm, family-friendly home for the things Sentient and the user
// have made together. Designed to feel like a personal drawer, not a file manager,
// but exposes full file-explorer capability for power moments (folders, zip,
// upload, share to phone). Shallow first; deeper on demand.

const FILE_ICON = {
  folder:   "folder",
  recipe:   "pot",
  list:     "list-check",
  schedule: "calendar",
  doc:      "doc",
  photo:    "image",
  audio:    "audio",
  sheet:    "sheet",
  other:    "doc",
};

const FILE_TINT = {
  folder:   "amber",
  recipe:   "terra",
  list:     "sage",
  schedule: "indigo",
  doc:      "ink",
  photo:    "rose",
  audio:    "indigo",
  sheet:    "sage",
  other:    "ink",
};

// Friendly mock workspace — what an agent's docker volume might look like
// for a family member, surfaced in a way they'd actually understand.
const MOCK_WORKSPACE = {
  "/": [
    { id: "f-cooking",   kind: "folder", name: "Cooking",      count: 14, modified: "2h ago" },
    { id: "f-school",    kind: "folder", name: "School",       count: 6,  modified: "yesterday" },
    { id: "f-trips",     kind: "folder", name: "Trips & plans", count: 4, modified: "Mon" },
    { id: "f-camera",    kind: "folder", name: "Doorbell clips", count: 38, modified: "4m ago" },
    { id: "i-list-1",    kind: "list",     name: "Tuesday's grocery list", subtitle: "12 things · 4 checked off", modified: "1h ago" },
    { id: "i-doc-1",     kind: "doc",      name: "Mia's birthday plan",    subtitle: "Saturday at 3pm · 8 friends", modified: "yesterday" },
    { id: "i-photo-1",   kind: "photo",    name: "Front door · 3:14pm",    subtitle: "Amazon delivery · Jordan",    modified: "3h ago" },
    { id: "i-recipe-1",  kind: "recipe",   name: "Sunday lasagna",         subtitle: "Sentient adapted Nan's recipe", modified: "5d ago" },
    { id: "i-doc-2",     kind: "doc",      name: "Field trip permission slip", subtitle: "PDF · awaiting signature", modified: "1w ago" },
    { id: "i-audio-1",   kind: "audio",    name: "Voice memo — David",      subtitle: "0:47 · about the dishwasher", modified: "2w ago" },
    { id: "i-sheet-1",   kind: "sheet",    name: "Monthly budget",          subtitle: "October · on track",          modified: "3w ago" },
  ],
  "/Cooking": [
    { id: "i-recipe-2", kind: "recipe", name: "Weekly meal plan", subtitle: "Mon–Fri dinners",            modified: "2h ago" },
    { id: "i-recipe-1", kind: "recipe", name: "Sunday lasagna",   subtitle: "Sentient adapted Nan's recipe", modified: "5d ago" },
    { id: "i-recipe-3", kind: "recipe", name: "Mia's pancakes",   subtitle: "Without eggs",                modified: "1w ago" },
    { id: "i-list-2",   kind: "list",   name: "Costco run",       subtitle: "8 things",                    modified: "1w ago" },
  ],
};

// ----- Item card -----------------------------------------------------------

const ItemCard = ({ item, onOpen }) => {
  const tint = FILE_TINT[item.kind] || "ink";
  const subtitle = item.kind === "folder"
    ? `${item.count} ${item.count === 1 ? "thing" : "things"}`
    : item.subtitle;

  return (
    <button className={`ws-item kind-${item.kind} tint-${tint}`} onClick={onOpen}>
      <span className="ws-item-icon">
        {item.kind === "photo"
          ? <span className="ws-photo-thumb"/>
          : <Icon name={FILE_ICON[item.kind]} size={20}/>}
      </span>
      <span className="ws-item-body">
        <span className="ws-item-name">{item.name}</span>
        {subtitle && <span className="ws-item-sub">{subtitle}</span>}
      </span>
      <span className="ws-item-time">{item.modified}</span>
    </button>
  );
};

// ----- Agent activity card -------------------------------------------------

const AgentActivity = ({ activity }) => {
  if (!activity) return null;
  return (
    <div className="ws-activity">
      <span className="ws-activity-pulse"/>
      <div className="ws-activity-body">
        <div className="ws-activity-title">Sentient is working on something for you</div>
        <div className="ws-activity-sub">{activity}</div>
      </div>
    </div>
  );
};

// ----- Preview overlay -----------------------------------------------------

const Preview = ({ item, onClose, onShare, onDownload, onDelete }) => {
  if (!item) return null;

  return (
    <div className="ws-preview">
      <div className="ws-preview-bar">
        <button className="icon-btn" onClick={onClose} title="Back">
          <Icon name="chevron-left" size={18}/>
        </button>
        <div className="ws-preview-title">{item.name}</div>
        <span className="spacer"/>
        <button className="ws-action" onClick={onShare} title="Send to phone">
          <Icon name="share-phone" size={16}/><span>Send to phone</span>
        </button>
        <button className="icon-btn" onClick={onDownload} title="Download">
          <Icon name="download" size={16}/>
        </button>
        <button className="icon-btn ws-danger" onClick={onDelete} title="Delete">
          <Icon name="trash" size={16}/>
        </button>
      </div>

      <div className="ws-preview-body">
        <PreviewContent item={item}/>
      </div>
    </div>
  );
};

// Renders a friendly, content-shaped preview per kind. Designed for non-technical
// users — looks like the thing itself, not a generic "file viewer".
const PreviewContent = ({ item }) => {
  switch (item.kind) {
    case "list":
      return (
        <div className="paper">
          <h3 className="paper-title">{item.name}</h3>
          <p className="paper-sub">{item.subtitle}</p>
          <ul className="paper-list">
            {[
              { t: "Eggs (dozen)", done: true },
              { t: "Milk — oat",    done: true },
              { t: "Tomatoes",       done: true },
              { t: "Pasta — rigatoni" },
              { t: "Parmesan" },
              { t: "Garlic" },
              { t: "Olive oil" },
              { t: "Basil — fresh" },
            ].map((row, i) => (
              <li key={i} className={row.done ? "done" : ""}>
                <span className="check">{row.done ? "✓" : ""}</span>{row.t}
              </li>
            ))}
          </ul>
        </div>
      );
    case "recipe":
      return (
        <div className="paper">
          <h3 className="paper-title">{item.name}</h3>
          <p className="paper-sub">Serves 6 · 1h 20m · adapted by Sentient</p>
          <h4 className="paper-h">Ingredients</h4>
          <ul className="paper-list bullets">
            <li>500g rigatoni</li><li>2 cans peeled tomatoes</li>
            <li>4 cloves garlic</li><li>1 onion</li>
            <li>250g ricotta</li><li>200g mozzarella</li>
            <li>Fresh basil, salt, pepper</li>
          </ul>
          <h4 className="paper-h">Method</h4>
          <ol className="paper-list ordered">
            <li>Sweat the onion and garlic in olive oil until soft.</li>
            <li>Add tomatoes; simmer 25 minutes; season.</li>
            <li>Layer pasta, sauce, ricotta, mozzarella; repeat.</li>
            <li>Bake at 200°C for 30 minutes until bubbling.</li>
          </ol>
        </div>
      );
    case "doc":
      return (
        <div className="paper">
          <h3 className="paper-title">{item.name}</h3>
          <p className="paper-sub">{item.subtitle}</p>
          <p>Saturday, the 14th — 3:00pm at our house.</p>
          <p>Eight friends from Mia's class. Pizza, garden games, a small cake. The Hendersons offered to bring drinks.</p>
          <p className="paper-sub">Sentient drafted the invitation. Reply to send.</p>
        </div>
      );
    case "photo":
      return (
        <div className="paper photo-paper">
          <div className="ws-photo-large"/>
          <p className="paper-sub">Front door camera · today at 3:14pm</p>
        </div>
      );
    case "audio":
      return (
        <div className="paper">
          <h3 className="paper-title">{item.name}</h3>
          <p className="paper-sub">{item.subtitle}</p>
          <div className="audio-row">
            <button className="play-circle"><Icon name="play" size={18}/></button>
            <div className="audio-bars">
              {Array.from({length: 38}).map((_, i) =>
                <span key={i} style={{height: `${20 + Math.abs(Math.sin(i)) * 60}%`}}/>
              )}
            </div>
            <span className="audio-time">0:47</span>
          </div>
        </div>
      );
    case "sheet":
      return (
        <div className="paper">
          <h3 className="paper-title">{item.name}</h3>
          <p className="paper-sub">{item.subtitle}</p>
          <table className="paper-table">
            <thead><tr><th>Category</th><th>Budgeted</th><th>Spent</th></tr></thead>
            <tbody>
              <tr><td>Groceries</td><td>$800</td><td>$612</td></tr>
              <tr><td>Utilities</td><td>$240</td><td>$238</td></tr>
              <tr><td>Kids</td><td>$400</td><td>$291</td></tr>
              <tr><td>Eating out</td><td>$200</td><td>$340</td></tr>
            </tbody>
          </table>
        </div>
      );
    default:
      return <div className="paper"><h3 className="paper-title">{item.name}</h3></div>;
  }
};

// ----- Drawer --------------------------------------------------------------

const WorkspaceDrawer = ({ open, onClose }) => {
  const [path, setPath] = React.useState("/");
  const [opened, setOpened] = React.useState(null); // currently-previewed item
  const [activity, setActivity] = React.useState("Drafting a weekly meal plan from your last 4 grocery lists…");

  // expose for the LLM tool call
  React.useEffect(() => {
    window.sentient = window.sentient || {};
    window.sentient.openWorkspace  = () => onClose(false);
    window.sentient.setActivity    = (msg) => setActivity(msg || null);
  }, [onClose]);

  const items = MOCK_WORKSPACE[path] || [];
  const segments = path === "/" ? [] : path.slice(1).split("/");

  const open_item = (item) => {
    if (item.kind === "folder") {
      setPath(path === "/" ? `/${item.name}` : `${path}/${item.name}`);
    } else {
      setOpened(item);
    }
  };

  const goUp = () => {
    if (segments.length === 0) return;
    setPath(segments.length === 1 ? "/" : "/" + segments.slice(0, -1).join("/"));
  };

  return (
    <>
      <div className={`ws-backdrop ${open ? "show" : ""}`} onClick={onClose}/>
      <aside className={`ws-drawer ${open ? "show" : ""}`} aria-hidden={!open}>
        <header className="ws-head">
          <div className="ws-head-titles">
            <h2 className="ws-title">Workspace</h2>
            <p className="ws-subtitle">Things Sentient and you have made together</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={18}/>
          </button>
        </header>

        <div className="ws-toolbar">
          <div className="ws-crumbs">
            {segments.length > 0 && (
              <button className="ws-crumb-back" onClick={goUp} title="Back">
                <Icon name="chevron-left" size={14}/>
              </button>
            )}
            <button className="ws-crumb" onClick={() => setPath("/")}>Workspace</button>
            {segments.map((seg, i) => (
              <React.Fragment key={i}>
                <span className="ws-crumb-sep">/</span>
                <button className="ws-crumb"
                        onClick={() => setPath("/" + segments.slice(0, i+1).join("/"))}>
                  {seg}
                </button>
              </React.Fragment>
            ))}
          </div>
          <span className="spacer"/>
          <button className="ws-tool" title="New folder">
            <Icon name="folder-plus" size={15}/><span>New folder</span>
          </button>
          <button className="ws-tool primary" title="Upload">
            <Icon name="upload" size={15}/><span>Upload</span>
          </button>
        </div>

        <div className="ws-body">
          <AgentActivity activity={path === "/" ? activity : null}/>

          {items.length === 0 ? (
            <div className="ws-empty">
              <Icon name="folder" size={32}/>
              <p>This folder is empty.</p>
            </div>
          ) : (
            <div className="ws-grid">
              {items.map(item => (
                <ItemCard key={item.id} item={item} onOpen={() => open_item(item)}/>
              ))}
            </div>
          )}
        </div>

        <footer className="ws-foot">
          <span>{items.length} {items.length === 1 ? "thing" : "things"} here</span>
          <span className="spacer"/>
          <button className="ws-tool subtle" title="Download everything as a zip">
            <Icon name="download" size={14}/><span>Download all</span>
          </button>
        </footer>

        <Preview
          item={opened}
          onClose={() => setOpened(null)}
          onShare={() => {}}
          onDownload={() => {}}
          onDelete={() => setOpened(null)}
        />
      </aside>
    </>
  );
};

window.WorkspaceDrawer = WorkspaceDrawer;
