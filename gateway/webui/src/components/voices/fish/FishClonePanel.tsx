// gateway/webui/src/components/voices/fish/FishClonePanel.tsx
//
// Browse/search/filter/preview Fish Audio's public voice library and let the
// caller (AddVoiceModal) turn a pick into a clone. Adapted from the retired
// settings voice-pane.tsx (git rev 115fb59^): keeps the debounced server
// search, client-side facet filters, and the load-more/preview machinery
// verbatim; drops the profile-draft wiring and PaneHead/Card chrome that
// belonged to the old Settings > Voice pane. This panel owns no "current
// selection" — picking a tile hands the voice off to the modal's own
// name/description/tags editor via `onClone`.

import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { normalizeLanguage } from "@sentient/config";
import { createFishApi, type FishVoiceEntry } from "../../../services/fish-api.ts";
import { Btn } from "../../settings/primitives/btn.tsx";
import { Icon } from "../../common/icon.tsx";
import { FishToolbar } from "./fish-toolbar.tsx";
import { VoiceTile } from "./fish-voice-tile.tsx";
import {
  applyFilters,
  canonicalizeVibe,
  deriveFilterOptions,
  isAnyFilterActive,
  sortVoices,
  toggleInArray,
  type SortKey,
  type VoiceFilters,
} from "./fish-bucket.ts";

const log = createLogger(["sentient", "webui", "fish", "clone-panel"]);
const PAGE_INCREMENT = 12;
const SEARCH_DEBOUNCE_MS = 300;
// Modal's own editor (AddVoiceModal.MAX_TAGS) re-caps independently; this
// just keeps the initial suggestion list from ballooning.
const SUGGESTED_TAG_LIMIT = 8;

const DEFAULT_FILTERS: VoiceFilters = {
  q: "",
  language: "all",
  genders: [],
  ages: [],
  vibes: [],
};

const fishApi = createFishApi();

export interface FishClonePickInput {
  fishVoiceId: string;
  suggestedName: string;
  suggestedTags: string[];
  /** Fish's first listed language, normalized to a Qwen3-TTS-supported code
   *  (or "" when Fish's language isn't one we support — see normalizeLanguage). */
  suggestedLanguage: string;
}

export interface FishClonePanelProps {
  token: string;
  /** True while a clone request is in flight (owned by AddVoiceModal) —
   *  gates picking another voice while one is already being cloned. */
  busy: boolean;
  onClone: (input: FishClonePickInput) => void;
}

export function FishClonePanel({ token, busy, onClone }: FishClonePanelProps): JSX.Element {
  const [voices, setVoices] = useState<FishVoiceEntry[] | null>(null);
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
  const [pickedId, setPickedId] = useState<string | null>(null);
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

  const togglePreview = (v: FishVoiceEntry) => {
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
      const r = await fishApi.listVoices(token, opts);
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
  }, [token, debouncedQ]);

  // Q-driven resets are handled by the fetch effect above; this one only
  // catches the purely client-side facets (sort + non-q filters).
  useEffect(() => {
    setVisibleCount(PAGE_INCREMENT);
  }, [filters.language, filters.genders, filters.ages, filters.vibes, sort]);

  const options = useMemo(() => deriveFilterOptions(voices ?? []), [voices]);
  const filtered = useMemo(() => sortVoices(applyFilters(voices ?? [], filters), sort), [voices, filters, sort]);
  const visible = filtered.slice(0, visibleCount);
  const filterActive = isAnyFilterActive(filters);

  const loadMoreFromServer = async () => {
    if (loadingMore || !hasMoreFromServer) return;
    const nextPage = currentPage + 1;
    const seq = ++fetchSeqRef.current;
    setLoadingMore(true);
    const opts: { title?: string; page: number } = { page: nextPage };
    if (debouncedQ !== "") opts.title = debouncedQ;
    const r = await fishApi.listVoices(token, opts);
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

  if (loadError) {
    return <p class="pane-error">{loadError}</p>;
  }

  if (!voices) {
    return <div class="pane-skeleton" aria-hidden="true" />;
  }

  const handleSelect = (v: FishVoiceEntry) => {
    if (busy) return;
    log.debug("voice.picked", { id: v.id });
    setPickedId(v.id);
    onClone({
      fishVoiceId: v.id,
      suggestedName: v.title,
      suggestedTags: v.tags.slice(0, SUGGESTED_TAG_LIMIT),
      suggestedLanguage: normalizeLanguage(v.languages[0] ?? ""),
    });
  };

  const handleVibeTagClick = (t: string) => {
    const canonical = canonicalizeVibe(t, options);
    setFilters((f) => ({ ...f, vibes: toggleInArray(f.vibes, canonical) }));
  };

  const hasClientMore = filtered.length > visibleCount;
  const loadMoreLabel = loadingMore
    ? "Loading…"
    : hasClientMore
      ? `Load more · ${visibleCount} of ${filtered.length}`
      : "Load more from server";

  return (
    <>
      <FishToolbar
        filters={filters}
        setFilters={setFilters}
        sort={sort}
        setSort={setSort}
        options={options}
        vibesExpanded={vibesExpanded}
        setVibesExpanded={setVibesExpanded}
      />

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
            selected={pickedId === v.id}
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
}
