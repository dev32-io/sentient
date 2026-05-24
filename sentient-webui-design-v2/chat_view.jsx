// Chat view — the conversation mockup

const ChatView = () => (
  <div className="chat-wrap">
    <div className="chat">

      <div className="day-divider">Today · 7:42 AM</div>

      {/* 1 */}
      <Message role="user" name="Maya" time="7:42 AM" avatarChar="M">
        <div className="bubble">
          Morning. Can you turn on the kitchen lights and start my coffee routine?
        </div>
      </Message>

      {/* 2 */}
      <Message role="assistant" name="Sentient" time="7:42 AM"
               voice={{ state: "played", duration: "0:08" }}>
        <div className="bubble">
          Good morning, Maya. Starting the Monday Morning scene — warming the kitchen
          and brewing a medium roast. I'll have the forecast ready in a moment.
          <ToolsBlock tools={[
            { icon:"lamp",   name:"run_scene",       status:"ok", subtitle:'scene: "Monday Morning" · 4 devices updated' },
            { icon:"thermo", name:"set_thermostat",  status:"ok", subtitle:"kitchen → 71°F · heating" },
            { icon:"spark",  name:"start_appliance", status:"ok", subtitle:'device: "Gaggia Espresso" · preset: medium roast' },
          ]}/>
        </div>
      </Message>

      {/* 3 */}
      <Message role="user" name="Maya" time="7:43 AM" avatarChar="M">
        <div className="bubble">
          What's the weather today? And play that album I was listening to last night in the kitchen.
        </div>
      </Message>

      {/* 4 */}
      <Message role="assistant" name="Sentient" time="7:43 AM"
               voice={{ state: "played", duration: "0:12" }}>
        <div className="bubble">
          It's <strong>54°F, overcast</strong> with a chance of light rain after 2pm —
          a jacket day. I'm queueing up <em>Currents</em> by Tame Impala on the kitchen Sonos.
          <ToolsBlock tools={[
            { icon:"globe", name:"web_search", status:"ok",
              subtitle:'"weather Oakland CA today" · 3 sources',
              result: (
                <dl className="kv">
                  <dt>location</dt><dd>Oakland, CA · 94607</dd>
                  <dt>now</dt><dd>54°F · overcast</dd>
                  <dt>high / low</dt><dd>61°F / 49°F</dd>
                  <dt>precip</dt><dd>38% after 14:00</dd>
                </dl>
              )},
            { icon:"music", name:"play_music", status:"ok",
              subtitle:'album: "Currents" · room: Kitchen · volume 32%' },
          ]}/>
        </div>
      </Message>

      {/* 5 */}
      <Message role="user" name="Maya" time="7:45 AM" avatarChar="M">
        <div className="bubble">
          Tell me a little about the guest staying with us this weekend — remind me of their dietary stuff.
        </div>
      </Message>

      {/* 6 — barge-in interrupted */}
      <Message role="assistant" name="Sentient" time="7:45 AM"
               voice={{ state: "interrupted" }}>
        <div className="bubble">
          Sure — your guest <strong>Elena</strong> is arriving Saturday evening. From your
          notes: she's vegetarian, avoids dairy, and mentioned a mild shellfish allergy.
          I can pull up a few dinner ideas that fit, or
          <span className="inline-tag">
            <span style={{width:6,height:6,borderRadius:"50%",background:"var(--ink-4)"}}/>
            interrupted
          </span>
        </div>
      </Message>

      {/* 7 */}
      <Message role="user" name="Maya" time="7:45 AM" avatarChar="M">
        <div className="bubble">
          Actually just add "plan Saturday dinner" to my list and text Jordan to grab flowers on the way home.
        </div>
      </Message>

      {/* 8 — streaming, speaking now */}
      <Message role="assistant" name="Sentient" time="7:45 AM"
               voice={{ state: "speaking" }}>
        <div className="bubble">
          Added to your list and message drafted. Want me to send it now, or hold it until
          Jordan's off work around 5<span className="cursor"/>
          <ToolsBlock tools={[
            { icon:"check", name:"add_to_list",  status:"ok",
              subtitle:'list: "Household" · item: "plan Saturday dinner w/ Elena"' },
            { icon:"phone", name:"send_message", status:"run",
              subtitle:"to: Jordan · waiting for confirmation" },
          ]}/>
        </div>
      </Message>

    </div>
  </div>
);

window.ChatView = ChatView;
