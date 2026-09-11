(() => {
  const lab = document.querySelector("[data-composer-lab]");
  if (!lab) return;

  const toast = document.querySelector("[data-composer-toast]");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sampleDraft = "Can you review tomorrow and prepare the safest adjustment?";
  let toastTimer = 0;

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2300);
  }

  function softlyTick() {
    if (navigator.vibrate && matchMedia("(pointer: coarse)").matches) navigator.vibrate(8);
  }

  function createComposer(frame) {
    const composer = frame.querySelector("[data-composer]");
    const input = frame.querySelector("[data-composer-input]");
    const action = frame.querySelector("[data-composer-action]");
    const voiceControl = frame.querySelector("[data-voice-control]");
    const leaves = [...frame.querySelectorAll("[data-voice-target]")];
    const leavesRoot = frame.querySelector(".voice-child-deck");
    const stopResponse = frame.querySelector("[data-stop-response]");
    const tts = frame.querySelector("[data-tts]");
    const attachmentInput = frame.querySelector("[data-attachment-input]");
    const taskSlot = frame.querySelector("[data-task-event-slot]");
    const isMobile = frame.classList.contains("composer-frame--mobile");

    let voice = "idle";
    let responding = false;
    let tasksVisible = false;
    let ttsEnabled = true;
    let fanOpen = false;
    let activeTarget = null;
    let pointerId = null;
    let pressedAt = 0;
    let pressX = 0;
    let pressY = 0;
    let lastX = 0;
    let lastY = 0;
    let fanTimer = 0;
    let suppressClick = false;

    function resizeInput() {
      input.style.height = "auto";
      const floor = isMobile ? 42 : 52;
      input.style.height = `${Math.min(isMobile ? 96 : 132, Math.max(floor, input.scrollHeight))}px`;
    }

    function syncTaskShelf() {
      if (!taskSlot) return;
      taskSlot.dataset.visible = String(tasksVisible);
      taskSlot.setAttribute("aria-hidden", String(!tasksVisible));
      if (tasksVisible) taskSlot.removeAttribute("inert");
      else {
        taskSlot.setAttribute("inert", "");
        frame.querySelectorAll("[data-task-pill]").forEach((button) => button.setAttribute("aria-expanded", "false"));
        frame.querySelectorAll("[data-task-detail]").forEach((detail) => { detail.hidden = true; });
      }
    }

    function syncTts() {
      tts.setAttribute("aria-pressed", String(ttsEnabled));
      tts.setAttribute("aria-label", ttsEnabled ? "Spoken responses on; turn off" : "Spoken responses off; turn on");
      tts.title = ttsEnabled ? "Spoken responses on" : "Spoken responses off";
      tts.querySelector("use").setAttribute("href", ttsEnabled ? "#i-volume" : "#i-volume-off");
    }

    function setFan(open, interactive = voice === "auto") {
      fanOpen = open;
      voiceControl.dataset.open = String(open);
      leavesRoot.setAttribute("aria-hidden", String(!open));
      leaves.forEach((leaf) => { leaf.tabIndex = open && interactive ? 0 : -1; });
    }

    function setTarget(next, tick = true) {
      if (activeTarget === next) return;
      activeTarget = next;
      leaves.forEach((leaf) => {
        const active = leaf.dataset.voiceTarget === next;
        leaf.dataset.active = String(active);
        if (leaf.dataset.voiceTarget === "auto") leaf.setAttribute("aria-pressed", String(voice === "auto"));
      });
      if (tick) softlyTick();
    }

    function setActionIcon(name) {
      const use = action.querySelector("use");
      if (use.getAttribute("href") === `#i-${name}`) return;
      use.setAttribute("href", `#i-${name}`);
      action.classList.remove("mode-transition");
      requestAnimationFrame(() => action.classList.add("mode-transition"));
    }

    function sync() {
      const listening = voice === "hold" || voice === "auto";
      const hasText = !listening && input.value.trim().length > 0;
      composer.dataset.voice = voice;
      composer.dataset.responding = String(responding);
      voiceControl.dataset.listening = String(listening);
      voiceControl.dataset.mode = voice;
      const stopSuppressed = voice === "hold";
      stopResponse.hidden = !responding;
      stopResponse.tabIndex = stopSuppressed ? -1 : 0;
      stopResponse.setAttribute("aria-hidden", String(!responding || stopSuppressed));
      input.readOnly = listening;
      action.classList.toggle("is-send", hasText);
      action.classList.toggle("voice-active", listening);

      if (hasText) {
        setActionIcon("send");
        action.setAttribute("aria-label", "Send message");
        action.title = "Send message";
      } else {
        setActionIcon(voice === "auto" ? "auto" : "mic");
        if (voice === "auto") {
          action.setAttribute("aria-label", "Auto listening is on; tap to turn it off");
          action.title = "Turn off Auto listening";
        } else if (voice === "hold") {
          action.setAttribute("aria-label", "Listening while held; drag to choose and release");
          action.title = "Listening";
        } else {
          action.setAttribute("aria-label", "Tap for Auto or hold to talk");
          action.title = "Talk to Sentient";
        }
      }
      resizeInput();
      syncTaskShelf();
    }

    function enterHold(event) {
      voice = "hold";
      pointerId = event.pointerId;
      pressedAt = Date.now();
      pressX = lastX = event.clientX;
      pressY = lastY = event.clientY;
      setTarget("send", false);
      setFan(false, false);
      action.setPointerCapture?.(pointerId);
      sync();
      showToast("Listening");
      clearTimeout(fanTimer);
      fanTimer = window.setTimeout(() => setFan(true, false), 105);
    }

    function enterAuto(fromHold = false) {
      clearTimeout(fanTimer);
      voice = "auto";
      setTarget("auto", false);
      setFan(false, false);
      sync();
      if (!fromHold) softlyTick();
      showToast("Auto listening is on · tap the Auto pod to turn it off");
    }

    function disableAuto() {
      voice = "idle";
      setFan(false, false);
      leaves.forEach((leaf) => {
        leaf.dataset.active = "false";
        if (leaf.dataset.voiceTarget === "auto") leaf.setAttribute("aria-pressed", "false");
      });
      activeTarget = null;
      sync();
      showToast("Auto listening is off");
    }

    function finishVoice(result) {
      clearTimeout(fanTimer);
      pointerId = null;
      voice = "idle";
      setFan(false, false);
      leaves.forEach((leaf) => {
        leaf.dataset.active = "false";
        if (leaf.dataset.voiceTarget === "auto") leaf.setAttribute("aria-pressed", "false");
      });
      activeTarget = null;
      if (result === "send") responding = true;
      sync();
      showToast(result === "send" ? "Voice message sent" : "Voice message cancelled");
    }

    function nearestTarget(x, y) {
      let nearest = "send";
      let distance = Infinity;
      leaves.forEach((leaf) => {
        const rect = leaf.getBoundingClientRect();
        const next = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
        if (next < distance) { distance = next; nearest = leaf.dataset.voiceTarget; }
      });
      return distance <= (isMobile ? 70 : 76) ? nearest : "send";
    }

    function releaseHold(event, cancelled = false) {
      if (pointerId === null || event.pointerId !== pointerId) return;
      clearTimeout(fanTimer);
      const elapsed = Date.now() - pressedAt;
      const distance = Math.hypot(lastX - pressX, lastY - pressY);
      try { action.releasePointerCapture?.(pointerId); } catch {}
      pointerId = null;
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 500);
      if (cancelled) { finishVoice("cancel"); return; }
      if (elapsed < 220 && distance < 12) { enterAuto(true); return; }
      if (activeTarget === "auto") enterAuto(true);
      else finishVoice(activeTarget === "cancel" ? "cancel" : "send");
    }

    function submitText() {
      if (!input.value.trim()) return;
      input.value = "";
      responding = true;
      sync();
      input.focus();
      showToast("Message sent");
    }

    function applyState(next) {
      clearTimeout(fanTimer);
      responding = next === "responding";
      tasksVisible = next === "tasks";
      input.value = next === "text" ? sampleDraft : "";
      voice = next === "hold" ? "hold" : next === "auto" ? "auto" : "idle";
      if (voice === "hold") { setTarget("send", false); setFan(true, false); }
      else if (voice === "auto") { setTarget("auto", false); setFan(false, false); }
      else setFan(false, false);
      sync();
    }

    frame.addEventListener("click", (event) => {
      const target = event.target;
      const taskPill = target.closest("[data-task-pill]");
      if (taskPill) {
        const key = taskPill.dataset.taskPill;
        const open = taskPill.getAttribute("aria-expanded") === "true";
        frame.querySelectorAll("[data-task-pill]").forEach((button) => button.setAttribute("aria-expanded", "false"));
        frame.querySelectorAll("[data-task-detail]").forEach((detail) => { detail.hidden = true; });
        if (!open) {
          taskPill.setAttribute("aria-expanded", "true");
          frame.querySelector(`[data-task-detail="${key}"]`).hidden = false;
        }
        return;
      }
      if (target.closest("[data-attach]")) { attachmentInput.click(); return; }
      if (target.closest("[data-tts]")) {
        ttsEnabled = !ttsEnabled;
        syncTts();
        showToast(ttsEnabled ? "Spoken responses on" : "Spoken responses off");
        return;
      }
      if (target.closest("[data-stop-response]")) {
        if (!responding) return;
        responding = false;
        sync();
        showToast("Response stopped. No changes were made.");
        return;
      }
      if (target.closest("[data-review-permission]")) showToast("Approval review belongs in its own permission surface.");
    });

    input.addEventListener("input", sync);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitText(); }
    });
    composer.addEventListener("submit", (event) => { event.preventDefault(); submitText(); });
    composer.addEventListener("pointerdown", (event) => {
      if (event.target.closest("textarea, button, input, select, a, [role='button']")) return;
      event.preventDefault();
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });

    action.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || voice === "auto" || input.value.trim()) return;
      event.preventDefault();
      enterHold(event);
    });
    action.addEventListener("pointermove", (event) => {
      if (pointerId === null || event.pointerId !== pointerId || voice !== "hold") return;
      lastX = event.clientX;
      lastY = event.clientY;
      if (Date.now() - pressedAt >= 72 || Math.hypot(lastX - pressX, lastY - pressY) >= 8) {
        setFan(true, false);
        setTarget(nearestTarget(lastX, lastY));
      }
    });
    action.addEventListener("pointerup", (event) => releaseHold(event));
    action.addEventListener("pointercancel", (event) => releaseHold(event, true));
    action.addEventListener("click", (event) => {
      if (suppressClick) { event.preventDefault(); return; }
      if (input.value.trim()) { submitText(); return; }
      if (voice === "auto") disableAuto();
      else if (event.detail === 0 && voice === "idle") enterAuto(false);
    });
    action.addEventListener("animationend", () => action.classList.remove("mode-transition"));

    attachmentInput.addEventListener("change", () => {
      const count = attachmentInput.files?.length || 0;
      if (count) showToast(`${count} ${count === 1 ? "attachment" : "attachments"} selected`);
    });

    syncTts();
    applyState("idle");
    if (!reducedMotion) frame.animate([{ opacity: 0, transform: "translateY(12px) scale(.992)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], { duration: 420, easing: "cubic-bezier(.16,1,.3,1)" });

    return { applyState };
  }

  const composers = [...document.querySelectorAll("[data-composer-instance]")].map(createComposer);

  document.querySelectorAll("[data-review-state]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.reviewState;
      document.querySelectorAll("[data-review-state]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      composers.forEach((instance) => instance.applyState(next));
    });
  });

  window.SentientComponents?.enhance(document);
})();
