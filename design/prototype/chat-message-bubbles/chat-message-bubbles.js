(() => {
  const demo = document.querySelector("[data-chat-state-demo]");
  const control = document.querySelector("[data-chat-state-control]");
  if (!demo || !control) return;

  const avatar = demo.querySelector("[data-chat-state-avatar]");
  const time = demo.querySelector("[data-chat-state-time]");
  const content = demo.querySelector("[data-chat-state-content]");
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let revealFrame = 0;
  let releaseSizeTimer = 0;
  let revealGeneration = 0;

  const states = {
    thinking: {
      avatar: "thinking",
      avatarLabel: "Sentient is thinking",
      time: "Now",
      className: "chat-message--thinking",
      content: '<div class="thinking-line" role="status"><span>Reviewing the schedule and travel time</span><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>'
    },
    streaming: {
      avatar: "responding",
      avatarLabel: "Sentient is responding",
      time: "Now",
      className: "chat-message--streaming",
      streamText: "I found one conflict. The appointment overlaps with school pickup, so I’m comparing travel time and the rehearsal start before suggesting a change. The safest option appears to be moving pickup to 3:40 pm while leaving the appointment unchanged."
    },
    complete: {
      avatar: "idle",
      avatarLabel: "Sentient",
      time: "6:42 pm",
      className: "chat-message--complete",
      content: '<p>I found one conflict. Moving pickup to <strong>3:40 pm</strong> keeps the appointment unchanged and preserves the travel buffer.</p>'
    },
    interrupted: {
      avatar: "idle",
      avatarLabel: "Sentient",
      time: "6:43 pm",
      className: "chat-message--interrupted",
      content: '<p>I’ll prepare the pickup adjustment and wait for your review before anything changes.</p><span class="interrupt-marker">Stopped when you spoke</span>'
    }
  };

  const stopReveal = () => {
    revealGeneration += 1;
    cancelAnimationFrame(revealFrame);
    clearTimeout(releaseSizeTimer);
    revealFrame = 0;
    releaseSizeTimer = 0;
    const surface = content?.querySelector(".streaming-bubble-surface");
    surface?.style.removeProperty("block-size");
  };

  const resizeSurfaceAround = (mutate) => {
    if (!content) return;
    const currentSurface = content.querySelector(".streaming-bubble-surface");
    const start = (currentSurface || content).getBoundingClientRect();
    mutate();
    const surface = content.querySelector(".streaming-bubble-surface");
    if (!surface || reducedMotion()) return;
    const end = content.getBoundingClientRect();

    surface.style.transition = "none";
    surface.style.blockSize = `${start.height}px`;
    surface.getBoundingClientRect();
    surface.style.removeProperty("transition");
    surface.style.blockSize = `${end.height}px`;
  };

  const startReveal = (fullText) => {
    if (!content) return;
    content.innerHTML = '<span class="streaming-bubble-surface" aria-hidden="true"></span><p><span data-stream-copy></span><span class="streaming-caret" aria-hidden="true"></span></p>';
    const copy = content.querySelector("[data-stream-copy]");
    if (!copy) return;

    if (reducedMotion()) {
      copy.textContent = fullText;
      return;
    }

    const generation = revealGeneration;
    let revealed = 0;
    let carry = 0;
    let lastFrame = 0;

    const tick = (now) => {
      if (generation !== revealGeneration) return;
      if (!lastFrame) lastFrame = now;
      const elapsed = Math.min(64, now - lastFrame);
      lastFrame = now;
      const gap = fullText.length - revealed;
      const rate = Math.min(32, Math.max(14, 18 * (1 + gap * .004)));
      const earned = carry + rate * elapsed / 1000;
      const whole = Math.min(gap, Math.floor(earned));
      carry = earned - whole;

      if (whole > 0) {
        revealed += whole;
        resizeSurfaceAround(() => { copy.textContent = fullText.slice(0, revealed); });
      }

      if (revealed < fullText.length) {
        revealFrame = requestAnimationFrame(tick);
      } else {
        releaseSizeTimer = window.setTimeout(() => {
          if (generation !== revealGeneration || !content) return;
          const surface = content.querySelector(".streaming-bubble-surface");
          surface?.style.removeProperty("block-size");
        }, 220);
      }
    };

    revealFrame = requestAnimationFrame(tick);
  };

  const applyState = (name) => {
    const state = states[name] || states.thinking;
    stopReveal();
    demo.classList.remove("chat-message--thinking", "chat-message--streaming", "chat-message--complete", "chat-message--interrupted");
    demo.classList.add(state.className);
    avatar?.setAttribute("state", state.avatar);
    avatar?.setAttribute("label", state.avatarLabel);
    if (time) time.textContent = state.time;
    if (state.streamText) startReveal(state.streamText);
    else if (content) content.innerHTML = state.content;
    control.querySelectorAll("[data-chat-state]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.chatState === name));
    });
  };

  control.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chat-state]");
    if (button) applyState(button.dataset.chatState);
  });
})();
