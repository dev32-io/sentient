(() => {
  const lab = document.querySelector("[data-composer-lab]");
  if (!lab) return;

  const frame = document.querySelector("[data-composer-frame]");
  const composer = document.querySelector("[data-composer]");
  const input = document.querySelector("[data-composer-input]");
  const action = document.querySelector("[data-composer-action]");
  const hint = document.querySelector("[data-composer-hint]");
  const taskSlot = document.querySelector("[data-task-event-slot]");
  const tts = document.querySelector("[data-tts]");
  const stopResponse = document.querySelector("[data-stop-response]");
  const attachmentInput = document.querySelector("[data-attachment-input]");
  const toast = document.querySelector("[data-composer-toast]");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let reviewState = "idle";
  let voice = "idle";
  let tasksVisible = false;
  let responding = false;
  let ttsEnabled = true;
  let holdTimer = 0;
  let holdActive = false;
  let ignoreVoiceClick = false;
  let toastTimer = 0;

  const sampleDraft = "Can you review tomorrow and prepare the safest adjustment?";

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2300);
  }

  function setActionIcon(name) {
    action.querySelector("use").setAttribute("href", `#i-${name}`);
    action.classList.remove("mode-transition");
    requestAnimationFrame(() => action.classList.add("mode-transition"));
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(132, Math.max(52, input.scrollHeight))}px`;
  }

  function syncTaskShelf() {
    taskSlot.dataset.visible = String(tasksVisible);
    taskSlot.setAttribute("aria-hidden", String(!tasksVisible));
    if (tasksVisible) taskSlot.removeAttribute("inert");
    else {
      taskSlot.setAttribute("inert", "");
      document.querySelectorAll("[data-task-pill]").forEach((button) => button.setAttribute("aria-expanded", "false"));
      document.querySelectorAll("[data-task-detail]").forEach((detail) => { detail.hidden = true; });
    }
  }

  function syncTts() {
    tts.setAttribute("aria-pressed", String(ttsEnabled));
    tts.setAttribute("aria-label", ttsEnabled ? "Spoken responses on; turn off" : "Spoken responses off; turn on");
    tts.title = ttsEnabled ? "Spoken responses on" : "Spoken responses off";
    tts.querySelector("use").setAttribute("href", ttsEnabled ? "#i-volume" : "#i-volume-off");
  }

  function syncComposer() {
    const hasText = input.value.trim().length > 0;
    composer.dataset.voice = voice;
    composer.dataset.responding = String(responding);
    stopResponse.hidden = !responding;
    action.classList.toggle("is-send", hasText);
    action.classList.toggle("voice-active", !hasText && voice !== "idle");

    if (hasText) {
      setActionIcon("send");
      action.setAttribute("aria-label", "Send message");
      action.title = "Send message";
      hint.textContent = "Enter to send · Shift+Enter for a new line";
    } else {
      setActionIcon("mic");
      if (voice === "hold") {
        hint.textContent = "Listening while held · release to send";
        action.setAttribute("aria-label", "Listening while held; release to send");
        action.title = "Listening while held";
      } else if (voice === "locked") {
        hint.textContent = "Listening hands-free · tap to stop";
        action.setAttribute("aria-label", "Hands-free voice on; tap to stop");
        action.title = "Hands-free voice on";
      } else {
        hint.textContent = "Tap to talk · hold while speaking";
        action.setAttribute("aria-label", "Tap for hands-free voice, or hold to talk");
        action.title = "Talk to Sentient";
      }
    }
    resizeInput();
    syncTaskShelf();
  }

  function applyReviewState(next) {
    reviewState = next;
    voice = next === "hold" ? "hold" : next === "locked" ? "locked" : "idle";
    tasksVisible = next === "tasks";
    responding = next === "responding";
    input.value = next === "text" ? sampleDraft : "";
    document.querySelectorAll("[data-review-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewState === reviewState)));
    syncComposer();
  }

  function submit() {
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    responding = true;
    reviewState = "responding";
    document.querySelectorAll("[data-review-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewState === reviewState)));
    syncComposer();
    input.focus();
    showToast("Message sent");
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    const review = target.closest("[data-review-state]");
    if (review) { applyReviewState(review.dataset.reviewState); return; }

    const taskPill = target.closest("[data-task-pill]");
    if (taskPill) {
      const key = taskPill.dataset.taskPill;
      const open = taskPill.getAttribute("aria-expanded") === "true";
      document.querySelectorAll("[data-task-pill]").forEach((button) => button.setAttribute("aria-expanded", "false"));
      document.querySelectorAll("[data-task-detail]").forEach((detail) => { detail.hidden = true; });
      if (!open) {
        taskPill.setAttribute("aria-expanded", "true");
        document.querySelector(`[data-task-detail="${key}"]`).hidden = false;
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
      reviewState = "idle";
      document.querySelectorAll("[data-review-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewState === reviewState)));
      syncComposer();
      showToast("Response stopped. No changes were made.");
      return;
    }
    if (target.closest("[data-review-permission]")) {
      showToast("Approval review belongs in its own permission surface.");
    }
  });

  input.addEventListener("input", () => {
    reviewState = input.value.trim() ? "text" : "idle";
    document.querySelectorAll("[data-review-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewState === reviewState)));
    syncComposer();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  composer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("textarea, button, input, select, a, [role='button']")) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });

  action.addEventListener("click", () => {
    if (input.value.trim()) { submit(); return; }
    if (ignoreVoiceClick) { ignoreVoiceClick = false; return; }
    voice = voice === "locked" ? "idle" : "locked";
    reviewState = voice === "locked" ? "locked" : "idle";
    document.querySelectorAll("[data-review-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewState === reviewState)));
    syncComposer();
    showToast(voice === "locked" ? "Listening hands-free · tap to stop" : "Voice listening stopped");
  });

  action.addEventListener("animationend", () => action.classList.remove("mode-transition"));
  action.addEventListener("pointerdown", () => {
    if (input.value.trim()) return;
    holdActive = false;
    holdTimer = window.setTimeout(() => {
      holdActive = true;
      voice = "hold";
      reviewState = "hold";
      document.querySelectorAll("[data-review-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewState === reviewState)));
      syncComposer();
      showToast("Listening while held");
    }, 420);
  });

  function releaseVoice() {
    clearTimeout(holdTimer);
    if (!holdActive) return;
    holdActive = false;
    ignoreVoiceClick = true;
    window.setTimeout(() => { ignoreVoiceClick = false; }, 600);
    voice = "idle";
    reviewState = "idle";
    document.querySelectorAll("[data-review-state]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewState === reviewState)));
    syncComposer();
    showToast("Voice note ready");
  }

  action.addEventListener("pointerup", releaseVoice);
  action.addEventListener("pointercancel", releaseVoice);
  action.addEventListener("pointerleave", releaseVoice);

  attachmentInput.addEventListener("change", () => {
    const count = attachmentInput.files?.length || 0;
    if (count) showToast(`${count} ${count === 1 ? "attachment" : "attachments"} selected`);
  });

  if (!reducedMotion) frame.animate([{ opacity: 0, transform: "translateY(14px) scale(.99)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], { duration: 440, easing: "cubic-bezier(.16,1,.3,1)" });

  syncTts();
  applyReviewState("idle");
  window.SentientComponents?.enhance(document);
})();
