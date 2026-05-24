// gateway/webui/src/components/settings/panes/voice-pane.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ProvidersApi, VoiceEntry } from "../../../services/providers-api.ts";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { SearchField } from "../primitives/search-field.tsx";
import { Select } from "../primitives/select.tsx";
import { Chip } from "../primitives/chip.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Icon } from "../../common/icon.tsx";
import { VoiceFilterSection } from "./voice-filter-section.tsx";
import { VoiceTile } from "./voice-tile.tsx";
import { VoiceSavedTile } from "./voice-saved-tile.tsx";
import { langDisplay } from "./voice-langs.ts";
import {
  applyFilters,
  canonicalizeVibe,
  deriveFilterOptions,
  isAnyFilterActive,
  sortVoices,
  toggleInArray,
  type SortKey,
  type VoiceFilters,
} from "./voice-bucket.ts";

const log = createLogger(["sentient", "webui", "settings", "voice-pane"]);
const PAGE_INCREMENT = 12;
const VIBE_COLLAPSED_COUNT = 8;
const SEARCH_DEBOUNCE_MS = 300;

const SORT_OPTIONS = [
  { value: "popular", label: "Popular" },
  { value: "recent", label: "Recent" },
  { value: "az", label: "A–Z" },
];

const DEFAULT_FILTERS: VoiceFilters = {
  q: "",
  language: "all",
  genders: [],
  ages: [],
  vibes: [],
};

export interface VoicePaneProps {
  api: ProvidersApi;
  token: string;
  draft: ProfileV1;
  /**
   * Last-saved voice. Drives the "Current selection" tile, which only
   * updates after a successful Apply — not on every draft mutation.
   */
  savedVoice: ProfileV1["voice"] | null;
  onDraftVoice: (voice: ProfileV1["voice"]) => void;
  /** When true, suppresses the PaneHead title/subtitle (caller supplies its own). */
  hideHead?: boolean;
  /** When true, suppresses the "Currently using" Card wrapper. Wizard usage
   *  is one-shot pick-and-go; the saved-vs-draft distinction doesn't apply. */
  hideSavedTile?: boolean;
}

export function VoicePane({ api, token, draft, savedVoice, onDraftVoice, hideHead, hideSavedTile }: VoicePaneProps): JSX.Element {
  const [voices, setVoices] = useState<VoiceEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<VoiceFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>("popular");
  const [visibleCount, setVisibleCount] = useState(PAGE_INCREMENT);
  const [vibesExpanded, setVibesExpanded] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreFromServer, setHasMoreFromServer] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped on every kicked-off fetch; awaiting handlers compare and drop
  // stale responses (search-input bursts and load-more vs new search races).
  const fetchSeqRef = useRef(0);
  const [debouncedQ, setDebouncedQ] = useState("");

  const stopPreview = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setPlayingId(null);
  };

  const togglePreview = (v: VoiceEntry) => {
    if (!v.previewAudioUrl) return;
    if (playingId === v.id) {
      stopPreview();
      return;
    }
    stopPreview();
    const audio = new Audio(v.previewAudioUrl);
    audioRef.current = audio;
    setPlayingId(v.id);
    audio.addEventListener("ended", () => {
      if (audioRef.current === audio) stopPreview();
    });
    audio.play().catch((err) => {
      log.warn("preview.play.failed", { id: v.id, err: String(err) });
      stopPreview();
    });
  };

  useEffect(() => stopPreview, []);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQ(filters.q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [filters.q]);

  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    if (debouncedQ !== "") setSearching(true);
    setCurrentPage(1);
    setVisibleCount(PAGE_INCREMENT);
    void (async () => {
      const opts = debouncedQ === "" ? undefined : { title: debouncedQ };
      const r = await api.listVoices(token, opts);
      if (seq !== fetchSeqRef.current) return;
      setSearching(false);
      if (!r.ok) {
        log.warn("listVoices.failed", { code: r.error.code });
        if (debouncedQ === "") setLoadError("Couldn't load voices.");
        return;
      }
      setLoadError(null);
      setVoices(r.value.voices);
      setHasMoreFromServer(r.value.hasMore);
    })();
  }, [api, token, debouncedQ]);

  // Q-driven resets are handled by the fetch effect above; this one only
  // catches the purely client-side facets (sort + non-q filters).
  useEffect(() => {
    setVisibleCount(PAGE_INCREMENT);
  }, [filters.language, filters.genders, filters.ages, filters.vibes, sort]);

  const options = useMemo(() => deriveFilterOptions(voices ?? []), [voices]);
  const filtered = useMemo(
    () => sortVoices(applyFilters(voices ?? [], filters), sort),
    [voices, filters, sort],
  );
  const visible = filtered.slice(0, visibleCount);
  const filterActive = isAnyFilterActive(filters);

  const loadMoreFromServer = async () => {
    if (loadingMore || !hasMoreFromServer) return;
    const nextPage = currentPage + 1;
    const seq = ++fetchSeqRef.current;
    setLoadingMore(true);
    const opts: { title?: string; page: number } = { page: nextPage };
    if (debouncedQ !== "") opts.title = debouncedQ;
    const r = await api.listVoices(token, opts);
    if (seq !== fetchSeqRef.current) return;
    setLoadingMore(false);
    if (!r.ok) {
      log.warn("listVoices.loadMore.failed", { code: r.error.code, page: nextPage });
      return;
    }
    // Dedup by id — Fish's score-sorted pagination can shuffle entries across
    // page boundaries, so the same voice can appear on consecutive pages.
    setVoices((prev) => {
      const existing = new Set((prev ?? []).map((v) => v.id));
      const additions = r.value.voices.filter((v) => !existing.has(v.id));
      return [...(prev ?? []), ...additions];
    });
    setCurrentPage(nextPage);
    setHasMoreFromServer(r.value.hasMore);
    setVisibleCount((n) => n + PAGE_INCREMENT);
  };

  const handleLoadMore = () => {
    if (filtered.length > visibleCount) {
      setVisibleCount((n) => n + PAGE_INCREMENT);
      return;
    }
    void loadMoreFromServer();
  };

  // Pin selected vibes to the head of the visible list so a click-to-toggle
  // doesn't visually "lose" them behind the +N more button.
  const visibleVibes = useMemo(() => {
    if (vibesExpanded) return options.vibes;
    const selected = filters.vibes;
    const room = Math.max(0, VIBE_COLLAPSED_COUNT - selected.length);
    const head = options.vibes.filter((v) => !selected.includes(v)).slice(0, room);
    return [...selected, ...head];
  }, [options.vibes, filters.vibes, vibesExpanded]);

  if (loadError) {
    return (
      <>
        {!hideHead && (
          <PaneHead title="Voice" sub="The voice Sentient uses for replies. Powered by Fish Audio." />
        )}
        <p class="pane-error">{loadError}</p>
      </>
    );
  }

  if (!voices) {
    return (
      <>
        {!hideHead && (
          <PaneHead title="Voice" sub="The voice Sentient uses for replies. Powered by Fish Audio." />
        )}
        <div class="pane-skeleton" aria-hidden="true" />
      </>
    );
  }

  const handleSelect = (v: VoiceEntry) => {
    if (draft.voice?.id === v.id) return;
    onDraftVoice({ provider: "fish-audio", id: v.id });
  };

  const handleVibeTagClick = (t: string) => {
    const canonical = canonicalizeVibe(t, options);
    setFilters((f) => ({ ...f, vibes: toggleInArray(f.vibes, canonical) }));
  };

  const langOptions = [
    { value: "all", label: "All languages" },
    ...options.languages.map((code) => {
      const d = langDisplay(code);
      return { value: code, label: `${d.flag} ${d.name}` };
    }),
  ];

  const hiddenVibeCount = options.vibes.length - visibleVibes.length;
  const hasClientMore = filtered.length > visibleCount;
  const loadMoreLabel = loadingMore
    ? "Loading…"
    : hasClientMore
      ? `Load more · ${visibleCount} of ${filtered.length}`
      : "Load more from server";

  const savedTile = (
    <VoiceSavedTile
      api={api}
      token={token}
      saved={savedVoice}
      cached={voices}
      playingId={playingId}
      onPreview={togglePreview}
    />
  );

  const body = (
    <>
        <div class="v-toolbar">
          <SearchField
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: (e.target as HTMLInputElement).value }))}
            placeholder="Search voices…"
          />
          <Select
            value={filters.language}
            onChange={(l) => setFilters((f) => ({ ...f, language: l }))}
            options={langOptions}
          />
          <Select value={sort} onChange={(s) => setSort(s as SortKey)} options={SORT_OPTIONS} />
        </div>

        <div class="v-filters">
          <VoiceFilterSection
            label="Gender"
            options={options.genders}
            selected={filters.genders}
            onChange={(g) => setFilters((f) => ({ ...f, genders: g }))}
          />
          <VoiceFilterSection
            label="Age"
            options={options.ages}
            selected={filters.ages}
            onChange={(a) => setFilters((f) => ({ ...f, ages: a }))}
          />
          {options.vibes.length > 0 && (
            <div class="v-filter-row">
              <span class="v-filter-label">Tags</span>
              <div class="v-filter-chips">
                {visibleVibes.map((t) => (
                  <Chip
                    key={t}
                    active={filters.vibes.includes(t)}
                    onClick={() => setFilters((f) => ({ ...f, vibes: toggleInArray(f.vibes, t) }))}
                  >
                    {t}
                  </Chip>
                ))}
                {hiddenVibeCount > 0 && !vibesExpanded && (
                  <button type="button" class="v-tag-toggle" onClick={() => setVibesExpanded(true)}>
                    +{hiddenVibeCount} more
                  </button>
                )}
                {vibesExpanded && options.vibes.length > VIBE_COLLAPSED_COUNT && (
                  <button type="button" class="v-tag-toggle" onClick={() => setVibesExpanded(false)}>
                    Less
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div class="v-results">
          <span class="v-result-count">
            {searching && debouncedQ !== ""
              ? `Searching for "${debouncedQ}"…`
              : `${filtered.length} ${filtered.length === 1 ? "voice" : "voices"}`}
          </span>
          {filterActive && (
            <button type="button" class="v-clear" onClick={() => setFilters(DEFAULT_FILTERS)}>
              Clear all
            </button>
          )}
        </div>

        <div class="voice-grid">
          {visible.map((v) => (
            <VoiceTile
              key={v.id}
              voice={v}
              selected={draft.voice?.id === v.id}
              playing={playingId === v.id}
              onSelect={() => handleSelect(v)}
              onPreview={() => togglePreview(v)}
              onTagClick={handleVibeTagClick}
            />
          ))}
          {visible.length === 0 && (
            <div class="empty-pad">
              No voices match these filters.
              {filterActive && (
                <>
                  {" "}
                  <button type="button" class="v-clear" onClick={() => setFilters(DEFAULT_FILTERS)}>
                    Clear all
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {(hasClientMore || hasMoreFromServer) && (
          <div class="v-loadmore">
            <Btn kind="secondary" size="sm" disabled={loadingMore} onClick={handleLoadMore}>
              {loadMoreLabel}
              <Icon name="chevron" size={12} />
            </Btn>
          </div>
        )}
    </>
  );

  return (
    <>
      {!hideHead && (
        <PaneHead title="Voice" sub="The voice Sentient uses for replies. Powered by Fish Audio." />
      )}
      {hideSavedTile ? (
        body
      ) : (
        <>
          <Card title="Currently using">
            <div class="v-current">{savedTile}</div>
          </Card>
          <Card title="Browse voices">{body}</Card>
        </>
      )}
    </>
  );
}
