import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { TestConnection } from "../shared/test-connection.tsx";

type Provider = "ollama-cloud" | "openrouter" | "custom";

const TABS: ReadonlyArray<{ key: Provider; label: string }> = [
  { key: "ollama-cloud", label: "Ollama Cloud" },
  { key: "openrouter",  label: "OpenRouter" },
  { key: "custom",      label: "Custom" },
];

type ProviderState = { apiKey: string; baseUrl: string; testPassed: boolean };

const INITIAL_PROVIDER_STATE: Record<Provider, ProviderState> = {
  "ollama-cloud": { apiKey: "", baseUrl: "", testPassed: false },
  "openrouter":   { apiKey: "", baseUrl: "", testPassed: false },
  "custom":       { apiKey: "", baseUrl: "", testPassed: false },
};

export interface StepProviderProps { onAdvance: () => Promise<void>; }

export function StepProvider({ onAdvance }: StepProviderProps): JSX.Element {
  const [active, setActive] = useState<Provider>("ollama-cloud");
  const [providerState, setProviderState] = useState<Record<Provider, ProviderState>>(
    INITIAL_PROVIDER_STATE,
  );
  const [busy, setBusy] = useState(false);

  const ps = providerState[active];

  function patchActive(patch: Partial<ProviderState>): void {
    setProviderState(prev => ({ ...prev, [active]: { ...prev[active], ...patch } }));
  }

  async function testNow() {
    const res = await fetch("/api/v1/wizard/test-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: active,
        api_key: ps.apiKey || null,
        base_url: ps.baseUrl || null,
      }),
    });
    return await res.json();
  }

  function isPopulated(s: ProviderState): boolean {
    return s.apiKey.trim().length > 0 || s.baseUrl.trim().length > 0;
  }

  async function postProvider(p: Provider, s: ProviderState): Promise<Response> {
    return fetch("/api/v1/wizard/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: p,
        api_key: s.apiKey || null,
        base_url: s.baseUrl || null,
      }),
    });
  }

  async function continueStep() {
    setBusy(true);
    try {
      // Save every populated provider, then the active one LAST so its
      // setActiveLlmProvider call wins. The single-tab UI hides keys
      // typed into other tabs at submit time — losing them was the
      // surprise. Active provider always gets posted so its
      // active-flag is set even when its own fields are blank.
      const others = (Object.keys(providerState) as Provider[])
        .filter((p) => p !== active && isPopulated(providerState[p]));
      for (const p of others) {
        const res = await postProvider(p, providerState[p]);
        if (!res.ok) return;
      }
      const res = await postProvider(active, ps);
      if (res.ok) await onAdvance();
    } finally { setBusy(false); }
  }

  const canContinue = !busy;

  return (
    <section class="step-provider">
      <h2>Choose your LLM provider</h2>
      <nav class="step-provider__tabs">
        {TABS.map(t => (
          <button
            type="button"
            key={t.key}
            class={t.key === active ? "is-active" : ""}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div class="step-provider__form">
        {active === "ollama-cloud" && (
          <>
            <p class="hint">
              Hosted by Ollama at <code>https://ollama.com</code>. Get a key at{" "}
              <a href="https://ollama.com/settings/keys" target="_blank" rel="noopener noreferrer">
                ollama.com/settings/keys
              </a>.
              {" "}For a local Ollama daemon on your LAN, pick the <strong>Custom</strong> tab.
            </p>
            <label>API key
              <input
                type="password"
                value={ps.apiKey}
                onInput={e => patchActive({ apiKey: (e.target as HTMLInputElement).value })}
              />
            </label>
          </>
        )}
        {active === "openrouter" && (
          <>
            <label>API key
              <input
                type="password"
                placeholder="sk-or-..."
                value={ps.apiKey}
                onInput={e => patchActive({ apiKey: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label>Base URL (optional)
              <input
                type="text"
                value={ps.baseUrl}
                onInput={e => patchActive({ baseUrl: (e.target as HTMLInputElement).value })}
                placeholder="https://openrouter.ai/api/v1"
              />
            </label>
          </>
        )}
        {active === "custom" && (
          <>
            <label>Base URL
              <input
                type="text"
                value={ps.baseUrl}
                onInput={e => patchActive({ baseUrl: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label>API key (optional)
              <input
                type="password"
                value={ps.apiKey}
                onInput={e => patchActive({ apiKey: (e.target as HTMLInputElement).value })}
              />
            </label>
          </>
        )}
        <TestConnection
          key={active}
          onTest={testNow}
          onResult={passed => patchActive({ testPassed: passed })}
        />
      </div>
      <footer class="step-provider__footer">
        <button type="button" disabled={!canContinue} onClick={continueStep}>
          {busy ? "Saving..." : "Continue"}
        </button>
      </footer>
    </section>
  );
}
