# iOS chat performance audit

Status: source audit, not a measured root-cause verdict. This report is included in the approved PR scope. Findings describe the pre-repair working tree on `feature/message-attachments-drafts`; repair status appears below, and line references may move during repairs.

## Reported behavior and experiments

- iOS scrolling lags while thinking, streaming, and after text streaming while TTS plays; task-row scrolling also affected.
- Static scrolling is smooth.
- Web performance has not been tested by user. Do not generalize iOS observations to web.
- Temporary static-avatar build still lagged. This bypassed Rive view/model creation, not merely its active-state trigger.
- Subsequent build hiding bubble attachment thumbnails still lagged. Preview loading, decoding, storage and metadata remained enabled.
- Neither Rive rendering nor thumbnail display is necessary for reported lag. This does not establish that either costs nothing.
- No active-state physical-device Instruments trace captured during audit. Source-proven work is not proof of dominant frame cost.

## Priority findings

### 1. Empty thinking bubble drives nominal 60 Hz chat updates

**Confirmed repeated work. Fits thinking-only lag.**

`turn.started` seeds an empty live bubble before first token. Every 16 ms, reveal reducer changes `lastTickMs`, even if visible text remains empty. Internal `RevealState.distinctUntilChanged()` includes that timestamp, so active no-op presentation updates pass through. `ObserveChatUseCase` projects a full `ChatModel`; Swift collector assigns `@Published state`.

Evidence:
- `gateway/src/runtime/session-runtime.ts:1040–1049`: turn start emitted before provider work.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/InFlightMessageConnector.kt:61–85`: empty live message and MessageStarted.
- `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/RevealReducer.kt:193–205`.
- `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCase.kt:74–139,168–181`.
- `ios/App/Chat/ChatViewModel.swift:961–1002`.

Probe: count reveal ticks, distinct visible presentation changes and `applyChat` calls during empty thinking. Preserve internal accumulator/timing and lossless token events; suppress redundant presentation, not token delivery.

### 2. Already-acknowledged receipts repeatedly spawn draft-storage tasks

**Confirmed anti-pattern. Strong attachment-era lead.**

Each `applyChat` loops accumulated echoed pending IDs, searches committed messages for each receipt, and launches `drafts.acknowledge` again. No already-handled, in-flight or still-pending guard. Removing pending entry does not remove its ID from accumulated echo set.

`NativeDraftCoordinator.acknowledge` refreshes full draft snapshot even when pending row was already deleted and result is `found=false`.

At nominal tick cadence, N matching receipts can schedule roughly 62.5 × N tasks/second; this is a source-derived upper workload estimate, not a measured runtime rate. Receipt searches add O(receipts × history) work per model.

Evidence:
- `ios/App/Chat/ChatViewModel.swift:979–997`.
- `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/SdkConversationRepository.kt:20–30`.
- `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/draft/NativeDraftCoordinator.kt:96–109,155`.
- `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/draft/NativeDraftStore.kt:357–369`.

Probe: acknowledgment starts/results per pending ID across repeated identical chat models. Repair must preserve optimistic cleanup, retries after real failures, route fences and cancellation.

### 3. Attachment bookkeeping publishes unchanged state

**Confirmed with isolated Combine probe.**

Every `applyChat` prunes attachment previews. Pruning calls `attachmentPreviewFailures.formIntersection(ids)` on an `@Published` set, including unchanged empty sets.

Standalone Swift/Combine probe performed ten unchanged empty-set intersections and observed ten `objectWillChange` notifications. This proves notifications, not ten displayed frames; SwiftUI can coalesce them.

Each model also scans committed attachments for pruning and request eligibility. Hiding thumbnails leaves this work intact.

Evidence: `ios/App/Chat/ChatViewModel.swift:148,998–1001,1096–1109,1170–1177`.

Probe: no publication when pruned failure set is unchanged; publication when revoked IDs actually disappear.

### 4. Each model rebuilds history-derived structures

**Confirmed repeated work; scales with history/text size.**

Kotlin committed projection/live list, Swift chronology, layout rows, content-bearing revision strings, and collection revision/cache checks are reconstructed. Full message text participates in revision strings. Empty-thinking updates can traverse unchanged history repeatedly.

This does NOT mean every row redraws. Native collection guards avoid unchanged-cell reconfiguration, but upstream projection already ran.

Evidence:
- `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/model/ChatModel.kt:47–51`.
- `ios/App/Chat/message/MessageList.swift:38–83`.
- `ios/App/Chat/message/MessageRowLayout.swift:111–133`.
- `ios/App/Chat/message/MessageCollectionView.swift:233–245,318–350`.

Probe: compare short and long history with identical active reply; signpost projection and coordinator receive separately from cell configuration.

## Streaming-specific findings

### 5. Growing text reparses Markdown synchronously

**Confirmed work; not explanation for empty thinking alone.**

`StreamingText` constructs `Markdown(content)` from entire revealed prefix. Vendored implementation parses through cmark synchronously. Actual text changes replace live cell hosting root, then trigger native text layout and batched height reconciliation. Long replies, tables and code blocks may amplify cost.

Evidence:
- `ios/App/Chat/message/BubbleAnimations.swift:45–51`.
- `ios/Vendor/swift-markdown-ui/Sources/MarkdownUI/Views/Markdown.swift:237–239`.
- `ios/Vendor/swift-markdown-ui/Sources/MarkdownUI/DSL/Blocks/MarkdownContent.swift:88–91`.
- `ios/Vendor/swift-markdown-ui/Sources/MarkdownUI/Parser/MarkdownParser.swift:6–10`.
- `ios/App/Chat/message/MessageCollectionView.swift:760–830`.

Probe: Time Profiler cmark/Markdown/TextKit/SwiftUI layout during actual content revisions, not merely every ticker event.

### 6. Offscreen streaming can require exact hidden measurement

**Confirmed conditional cost. Prior visible-row optimization is retained.**

Visible mounted changed rows bootstrap from current layout height, avoiding hidden exact measurement until their host reports growth. Offscreen/unmounted changed rows lack that bootstrap and can enter `MessageRowMeasurer`, which synchronously lays out and calls `sizeThatFits` twice on main actor.

Do not claim every reveal tick performs hidden double measurement. No-content-change ticks ordinarily retain measurement keys; actual content revision and visibility determine path.

Evidence: `ios/App/Chat/message/MessageCollectionView.swift:322–380,1125–1178`.

Probe: separate counters for visible host updates, offscreen measurements, and geometry reconciliation; compare viewing active reply versus scrolling away.

## KMP, attachment and storage findings

### 7. Attachment bytes cross Swift bridge one byte at a time

**Confirmed; draft-preview conversion occurs on main actor.**

`KotlinByteArray.toData` loops over bytes using Kotlin getter for each byte. Draft-preview main-actor task performs conversion before detached image decoding. Remote preview closure also uses helper; exact executor should be traced rather than inferred from `async` alone.

Counterevidence: UIImage thumbnail decoding is already detached and downscaled to 640 pixels. Preview admission/cache/request bounds exist. This is more likely transient arrival cost than indefinite lag after previews settle.

Evidence:
- `ios/App/Settings/Voice/VoiceKotlinBytes.swift:20–31`.
- `ios/App/Chat/ChatViewModel.swift:305–306,1068–1078,1112–1122`.

Probe: signpost bridge conversion separately from fetch and detached decode, logging byte count only.

### 8. Several blocking draft operations lack explicit background boundary

**Synchronous work confirmed; complete SKIE executor attribution unresolved.**

Native storage performs SQLite queries, file copy, `fsync`, and preview generation inside suspend functions and mutex sections without explicit dispatcher switch. Swift mutation callers are main-actor tasks. `suspend`/`Mutex` do not automatically make work background; however, exact suspend-bridge execution must be verified before saying all Kotlin bodies run on main.

Store/coordinator locks serialize later mutations behind slow imports. Waits suspend rather than blocking OS thread, but work inside critical section remains synchronous. Repeated acknowledgment magnifies storage traffic.

Counterevidence: local preview body explicitly shifts to Default with concurrency bound; payloads remain files, not SQLite blobs; file copies/uploads stream in chunks. Synchronous DB construction from main-actor session creation is a separate startup risk, not direct explanation of ongoing thinking lag.

Evidence:
- `ios/App/Chat/attachments/AttachmentImportItem.swift:282–307`.
- `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/draft/NativeDraftStore.kt:173–326`.
- `shared/mobile-data/src/iosMain/kotlin/io/sentient/mobiledata/draft/IosNativeDraftStorage.ios.kt:102–209`.

Probe: thread/executor and duration at native adapter boundaries, especially reconcile/list/import; no content or filesystem-user-data logging.

### 9. SDK derives committed history repeatedly on serial background lane

**Confirmed work; potential background/audio contention.**

SDK factory uses `Dispatchers.Default.limitedParallelism(1)`, NOT Main. Connector callbacks and successful route completion can each call emit. Emit reconstructs committed timeline; StateFlow equality can suppress equivalent downstream delivery only after reconstruction.

Audio decode/scheduling shares SDK lane, so history work could delay scheduling. This is not proof of main-thread blocking or UI hitches.

Evidence:
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdkFactory.ios.kt:65`.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt:414–421,1250–1255`.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/StateDeriver.kt:173–197`.

Probe: audio arrival-to-schedule latency alongside emit/derive duration; preserve ordered state folding rather than adding unsafe parallel mutation.

## Animation/audio hypotheses

### 10. Responding bubble redraws full decorative surface

**Work confirmed; frame cost unmeasured.**

Responding TimelineView redraws face, gradients, multiple blurred shadows and speaking wave. Shadow overflow changes Canvas dimensions. Asynchronous Canvas presentation is not proof that all associated work is free of main/GPU pressure.

Important: breathing timeline is responding-only. Thinking has static active shadow plus independent dots. Do not apply responding timeline explanation to thinking-only lag.

Evidence: `ios/App/Chat/message/MessageBubbleShell.swift:147–151,305–377,401–445`.

Probe: phase-freeze bubble chrome only, keeping TTS/audio and content identical; inspect render-server/GPU waits as well as main CPU.

### 11. Running task indicators each own 24 Hz timeline

**Work confirmed; dominance unproven.**

Each running task animates opacity, scale and shadow. Thinking dots run three repeating animations. These compete with other work but are not independently proven expensive enough to cause reported severe lag.

Evidence:
- `ios/App/Chat/composer/ComposerTaskStrip.swift:625–658`.
- `ios/App/Chat/message/BubbleAnimations.swift:11–36`.

Probe: freeze one subsystem at a time while retaining identical task count/scroll gesture.

### 12. Audio allocation/copy pressure

**Background work confirmed; UI effect unmeasured.**

Downlink performs OGG accumulation/page/packet copies, Opus decode, PCM byte/float conversion, and AVAudio buffer allocation/scheduling. Native playback outstanding counter tracks drain but does not impose explicit scheduling backpressure. Raw held/queued-turn audio is bounded.

Counterevidence: downlink runs on SDK background lane; playback completion callback performs atomic accounting, not UI publication. Binary audio does not invalidate SwiftUI once per frame. Uplink has separate serial Default lane; microphone conversion runs in audio tap callback.

Kotlin GC/ARC pressure remains a theory, not diagnosis. Correlate safepoint signposts/allocations with hitches before changing runtime settings.

Evidence:
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audio/opus/OggOpusDemuxer.kt`.
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audio/opus/OpusDownlinkDecoder.kt`.
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/audioio/Pcm16FloatBuffer.ios.kt`.
- `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/voice/io/MediaPlaybackEngine.ios.kt:194–208`.

## Lower-priority suspects and confounds

- App-side per-model DEBUG logging and Vitals per-audio-event capture add work; OSLog disabled-level sanitizer evaluation is not established. Do not claim measured logging bottleneck.
- `scripts/ios-setup.sh` builds Debug KMP XCFramework and copies it to variant-neutral path. Xcode Release alone does not replace it with Release Kotlin. Installed build configuration unknown.
- Repository pins Kotlin 2.3.10, SKIE 0.10.11 and coroutines 1.11.0. Current online Kotlin docs may describe newer GC defaults; do not transplant defaults blindly.
- Prior optimization commits `3037c7fe` and `e2a3e605` are ancestors of current HEAD. Native collection identity, visible-height bootstrap, Rive pausing and static idle avatars remain implemented.
- Historical performance records primarily established removal of idle/hidden Rive work; active generation/audio and physical frame pacing were qualification gaps. See `qa/design-refresh/ios-hybrid-performance.md`.

## Verification boundary

Two safe static catalog profiles completed during audit; static 150-message fixtures do not exercise real reveal/TTS. Investigator reported focused `MessageListScrollTests` passing. Those establish functional/layout invariants, not FPS or active-state smoothness. Parent independently read decisive paths, corrected universal-hidden-measurement claim, and ran unchanged-@Published-set probe.

No production chats, production writes, raw audio or user-content logging performed.

## Approved first repair tranche

User approved first THREE findings only for initial performance repairs, alongside separate chat UX refinements:
1. Stop duplicate receipt acknowledgments without compromising retry/reconciliation.
2. Suppress unchanged chat presentation emissions while retaining internal reveal progress and events.
3. Avoid unchanged attachment-failure publication.

Do not imply those explain full TTS tail: reveal emissions stop when live bubble drains; responding chrome/audio can continue. Re-test normal visuals after removing temporary avatar/thumbnail ablations. Record device observations before choosing next optimization.

## First repair tranche: implemented and checked

The first three findings are now repaired in the working tree:

- `ObserveChatUseCase` suppresses structurally identical `ChatModel` output, while internal reveal reduction still consumes all ticks/deltas.
- Receipt reconciliation deduplicates handled/in-flight IDs, uses bounded retries independent of future model emissions, fences route/cancellation, and cleans only the owning receipt's attachment presentation. Exhaustion has an explicit UI Retry action, not per-tick rescheduling.
- Unchanged attachment failure-set pruning/removal no longer publishes redundant changes.

Temporary static-avatar and hidden-thumbnail experiments were removed. Normal visuals are restored. Clipboard, selection and attachment preview refinements were delivered alongside these fixes; export preparation runs off-main, and download filenames are defensively constrained.

Verification at the first-tranche checkpoint, before the continuous rich-text selection follow-up:
- Full WebUI: 661 tests passed; typecheck passed.
- Native iOS: 355 Swift Testing cases passed; XCTest executed 175 cases with two optional cases skipped and no failures (528 passed overall, two skipped).
- `shared:mobile-data:allTests` passed; updated MobileData XCFramework rebuilt/copied before native tests.
- Focused gateway attachment-storage tests: eight passed; gateway typecheck and scoped Biome check passed.
- Independent scoped review passed after repairs.
- Actual UIKit clipboard tests cover native mixed/text/file paste. Local browser fresh mixed paste persisted through reload without sending a server chat. Attachment-bearing browser preview/download E2E remains unverified without a disposable message fixture.

**Not established:** physical-device smoothness, hitch-rate improvement, or the remaining TTS-tail bottleneck. Re-test thinking/streaming/TTS/task scrolling on the user's iOS device before selecting another optimization. Tests prove contracts, not frame pacing.

## Continuous rich-text selection follow-up

Committed visible bubbles now use a WebKit selection surface so native selection handles can cross rendered Markdown blocks, including tables. Streaming, offscreen measurement, and initial/failure fallback retain the native renderer. This is a selection feature, **not a demonstrated performance improvement**.

The additional asynchronous rendering needs separate verification: document/font readiness and generation fences, viewport-independent height measurement, stable cached geometry after recycling, and cancellable shared image loading with off-main encoding. A few stable native-fallback frames do not establish that a WebKit row has finished rendering; geometry tests must observe actual readiness.

The final assembled native checkpoint passes 194 XCTest cases (two skipped) and 366 Swift Testing cases: 558 passed, two skipped. Simulator stress runs exposed WebContent startup delays around ten seconds alongside retained test-window rendering trees; test teardown now detaches the root controller, and geometry baselines wait for actual rendered readiness rather than stable fallback frames. These are test-lifecycle corrections, not evidence of faster production rendering.

On the final styled simulator build, actual native handle gestures selected across a checklist, link paragraph and table, followed by system Copy→Paste of the strict substring into the composer. A longer paste exposed an undersized SwiftUI measuring overlay; the composer now uses bounded native text measurement. Repeating the real paste verified five-line growth, six-line overflow with actual scrolling between the beginning and end, and unobstructed controls with the software keyboard shown and hidden. Keyboard hiding used the Simulator system control, not a demonstrated dismissal gesture. Screenshots were inspected directly. These synthetic catalog checks do not establish routed-backend behavior or physical-device smoothness; physical-device profiling remains outstanding.

## External references

- Apple, Optimize SwiftUI performance with Instruments: https://developer.apple.com/videos/play/wwdc2025/306/
- Kotlin/Native memory management and safepoint signposts: https://kotlinlang.org/docs/native-memory-manager.html
- Kotlin/Swift ARC integration: https://kotlinlang.org/docs/native-arc-integration.html
- SKIE Flow interoperability: https://skie.touchlab.co/features/flows

These explain measurement/interoperability mechanisms, not this app's root cause. Repository source and actual traces take precedence.
