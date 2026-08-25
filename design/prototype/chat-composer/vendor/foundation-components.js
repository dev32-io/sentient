(() => {
  function syncSegmentIndicator(group) {
    const selected = group.querySelector('.snt-segment[aria-pressed="true"]');
    if (!selected) return;
    group.style.setProperty("--snt-segment-x", `${selected.offsetLeft}px`);
    group.style.setProperty("--snt-segment-width", `${selected.offsetWidth}px`);
    group.dataset.sntReady = "true";
  }

  function enhance(root = document) {
    root.querySelectorAll("input[data-snt-indeterminate]:not([data-snt-bound])").forEach((input) => {
      input.dataset.sntBound = "true";
      input.indeterminate = true;
    });

    root.querySelectorAll(".snt-range:not([data-snt-bound])").forEach((range) => {
      range.dataset.sntBound = "true";
      const sync = () => {
        const min = Number(range.min || 0);
        const max = Number(range.max || 100);
        const value = Number(range.value || min);
        const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;
        range.style.setProperty("--snt-range-progress", `${progress}%`);
        const output = range.closest(".snt-range-row")?.querySelector("output");
        if (output) output.textContent = `${Math.round(value)}%`;
      };
      range.addEventListener("input", sync);
      sync();
    });

    root.querySelectorAll("[data-snt-toggle]:not([data-snt-bound])").forEach((toggle) => {
      toggle.dataset.sntBound = "true";
      toggle.addEventListener("click", () => {
        toggle.setAttribute("aria-checked", String(toggle.getAttribute("aria-checked") !== "true"));
      });
    });

    root.querySelectorAll("[data-snt-segmented]:not([data-snt-bound])").forEach((group) => {
      group.dataset.sntBound = "true";
      requestAnimationFrame(() => syncSegmentIndicator(group));
      group.addEventListener("click", (event) => {
        const selected = event.target.closest(".snt-segment");
        if (!selected || !group.contains(selected)) return;
        group.querySelectorAll(".snt-segment").forEach((segment) => {
          segment.setAttribute("aria-pressed", String(segment === selected));
        });
        requestAnimationFrame(() => syncSegmentIndicator(group));
      });
      if ("ResizeObserver" in window) {
        new ResizeObserver(() => syncSegmentIndicator(group)).observe(group);
      }
    });

    root.querySelectorAll("[data-snt-avatar-control]:not([data-snt-avatar-bound])").forEach((group) => {
      group.dataset.sntAvatarBound = "true";
      group.addEventListener("click", (event) => {
        const option = event.target.closest("[data-avatar-state]");
        if (!option || !group.contains(option)) return;
        const avatar = document.getElementById(group.dataset.sntAvatarControl);
        if (avatar) avatar.state = option.dataset.avatarState;
      });
    });

    root.querySelectorAll("[data-snt-chip]:not([data-snt-bound])").forEach((chip) => {
      chip.dataset.sntBound = "true";
      chip.addEventListener("click", () => {
        chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
      });
    });
  }

  window.SentientComponents = { enhance };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => enhance());
  } else {
    enhance();
  }
})();
