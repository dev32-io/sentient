// Settings page — focused on household members / user accounts

const SettingsView = () => {
  const [tab, setTab] = React.useState("members");
  return (
    <div className="settings">
      <h1>Household</h1>
      <p className="lead">Who lives here, what they can ask Sentient to do, and how it knows them.</p>

      <div className="settings-tabs">
        {[
          ["members", "Members"],
          ["permissions", "Permissions"],
          ["voices", "Voice profiles"],
          ["sessions", "Devices & sessions"],
          ["invites", "Invites"]
        ].map(([k, l]) => (
          <div key={k}
               className={`tab ${tab === k ? "active" : ""}`}
               onClick={() => setTab(k)}>
            {l}
          </div>
        ))}
      </div>

      {/* MEMBERS */}
      <div className="section">
        <h2>Members</h2>
        <p className="desc">Everyone with a recognized voice or account in this home.</p>

        <div className="member-list">
          <div className="member">
            <div className="avatar">M</div>
            <div className="info">
              <div className="name">Maya Chen · <span style={{color:"var(--ink-3)", fontWeight:400}}>you</span></div>
              <div className="sub">maya@chen.family · voice print enrolled · active on 3 devices</div>
            </div>
            <span className="role-pill admin">Owner</span>
            <button className="kebab"><Icon name="dots" size={16}/></button>
          </div>

          <div className="member">
            <div className="avatar sage">J</div>
            <div className="info">
              <div className="name">Jordan Chen</div>
              <div className="sub">jordan@chen.family · voice print enrolled · last seen 2h ago</div>
            </div>
            <span className="role-pill admin">Admin</span>
            <button className="kebab"><Icon name="dots" size={16}/></button>
          </div>

          <div className="member">
            <div className="avatar amber">E</div>
            <div className="info">
              <div className="name">Ellis Chen</div>
              <div className="sub">11 years old · kid profile · voice print enrolled</div>
            </div>
            <span className="role-pill kid">Kid</span>
            <button className="kebab"><Icon name="dots" size={16}/></button>
          </div>

          <div className="member">
            <div className="avatar clay">R</div>
            <div className="info">
              <div className="name">Rosa (housekeeper)</div>
              <div className="sub">Tue & Fri, 9am–1pm · scoped access · no voice print</div>
            </div>
            <span className="role-pill">Staff</span>
            <button className="kebab"><Icon name="dots" size={16}/></button>
          </div>

          <div className="member">
            <div className="avatar" style={{background:"var(--bg-sunk)", borderStyle:"dashed"}}>
              <Icon name="key" size={18}/>
            </div>
            <div className="info">
              <div className="name">Weekend guest · Elena</div>
              <div className="sub">Temporary pass · Apr 19 – Apr 21 · no voice print required</div>
            </div>
            <span className="role-pill guest">Guest</span>
            <button className="kebab"><Icon name="dots" size={16}/></button>
          </div>
        </div>

        <div className="member-invite">
          <Icon name="plus" size={16}/>
          <input placeholder="Invite someone by email or phone…"/>
          <button className="btn-primary">Send invite</button>
        </div>
      </div>

      {/* PERMISSIONS */}
      <div className="section">
        <h2>What each role can do</h2>
        <p className="desc">Scope who can unlock doors, spend money on orders, or change the whole-home setup.</p>

        <div className="perm-table">
          <div className="h">Capability</div>
          <div className="h">Owner</div>
          <div className="h">Admin</div>
          <div className="h">Kid</div>
          <div className="h">Guest</div>

          {[
            ["Control lights & climate", "on", "on", "on", "on"],
            ["Unlock doors", "on", "on", "off", "partial"],
            ["Play media & adjust volume", "on", "on", "on", "on"],
            ["Place orders (groceries, delivery)", "on", "on", "off", "off"],
            ["Run automations / scenes", "on", "on", "partial", "off"],
            ["Invite other members", "on", "off", "off", "off"],
            ["View activity log", "on", "on", "off", "off"],
          ].map(([cap, ...cells], i, arr) => (
            <React.Fragment key={cap}>
              <div className={`cell ${i === arr.length-1 ? "row-last" : ""}`}>{cap}</div>
              {cells.map((v, j) => (
                <div key={j} className={`cell ${i === arr.length-1 ? "row-last" : ""}`}>
                  <span className={`check ${v === "on" ? "on" : v === "partial" ? "partial" : ""}`}>
                    {v === "on" && <Icon name="check" size={12}/>}
                    {v === "partial" && <span style={{width:8, height:2, background:"currentColor", borderRadius:2}}/>}
                  </span>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>

        <div style={{display:"flex", gap:10, marginTop:18}}>
          <button className="btn-secondary"><Icon name="plus" size={14}/> Add custom role</button>
          <button className="btn-secondary">Review activity log</button>
        </div>
      </div>

      {/* SESSIONS */}
      <div className="section">
        <h2>Devices & sessions</h2>
        <p className="desc">Where Sentient is signed in, and where it's currently listening.</p>

        <div className="session-row">
          <div className="s-icon"><Icon name="phone" size={18}/></div>
          <div className="s-info">
            <div className="n">Maya's iPhone 17</div>
            <div className="m">Oakland, CA · last active now</div>
          </div>
          <span className="s-status"><span style={{width:6,height:6,borderRadius:"50%",background:"var(--sage)",boxShadow:"0 0 0 3px color-mix(in oklab, var(--sage) 30%, transparent)"}}/>Active now</span>
        </div>
        <div className="session-row">
          <div className="s-icon"><Icon name="tablet" size={18}/></div>
          <div className="s-info">
            <div className="n">Kitchen Display</div>
            <div className="m">Home hub · always-on · firmware 4.18.2</div>
          </div>
          <span className="s-status" style={{color:"var(--ink-3)"}}>Idle</span>
        </div>
        <div className="session-row">
          <div className="s-icon"><Icon name="laptop" size={18}/></div>
          <div className="s-info">
            <div className="n">Jordan's MacBook Air</div>
            <div className="m">Home WiFi · last active 2h ago</div>
          </div>
          <span className="s-status" style={{color:"var(--ink-3)"}}>Signed in</span>
        </div>

        <div style={{marginTop:16, display:"flex", gap:10}}>
          <button className="btn-secondary">Sign out all other devices</button>
        </div>
      </div>
    </div>
  );
};

window.SettingsView = SettingsView;
