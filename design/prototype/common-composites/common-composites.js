(() => {
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const popupAnimations = new WeakMap();

  const animatePopup = (element, open, origin = "top right") => {
    if (!element) return Promise.resolve();
    popupAnimations.get(element)?.cancel();
    element.style.transformOrigin = origin;

    if (reducedMotion()) {
      element.hidden = !open;
      element.dataset.state = open ? "open" : "closed";
      return Promise.resolve();
    }

    if (open) element.hidden = false;
    if (!open && element.hidden) return Promise.resolve();
    element.dataset.state = open ? "open" : "closing";
    const offset = origin.startsWith("bottom") ? "8px" : "-6px";
    const closeOffset = origin.startsWith("bottom") ? "6px" : "-4px";
    const frames = open
      ? [{ opacity: 0, transform: `translateY(${offset}) scale(.97)` }, { opacity: 1, transform: "translateY(0) scale(1)" }]
      : [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: `translateY(${closeOffset}) scale(.98)` }];
    const animation = element.animate(frames, {
      duration: open ? 250 : 150,
      easing: open ? "cubic-bezier(.2,.72,.24,1)" : "ease-in",
      fill: "both",
    });
    popupAnimations.set(element, animation);
    return animation.finished.catch(() => {}).then(() => {
      if (popupAnimations.get(element) !== animation) return;
      popupAnimations.delete(element);
      if (!open) element.hidden = true;
      element.dataset.state = open ? "open" : "closed";
      animation.cancel();
    });
  };

  const syncTabs = (tabs) => {
    const selected = tabs.querySelector('[aria-selected="true"]');
    if (!selected) return;
    const groupRect = tabs.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    tabs.style.setProperty("--tab-left", `${selectedRect.left - groupRect.left}px`);
    tabs.style.setProperty("--tab-width", `${selectedRect.width}px`);
  };

  all("[data-cmp-tabs]").forEach((tabs) => {
    syncTabs(tabs);
    tabs.addEventListener("click", (event) => {
      const next = event.target.closest("button");
      if (!next || !tabs.contains(next)) return;
      all("button", tabs).forEach((button) => button.setAttribute("aria-selected", String(button === next)));
      syncTabs(tabs);
    });
    new ResizeObserver(() => syncTabs(tabs)).observe(tabs);
  });

  const syncNav = (nav) => {
    const selected = nav.querySelector('[aria-current="page"]');
    if (!selected) return;
    const groupRect = nav.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    nav.style.setProperty("--nav-top", `${selectedRect.top - groupRect.top}px`);
    nav.style.setProperty("--nav-height", `${selectedRect.height}px`);
  };

  all("[data-cmp-nav]").forEach((nav) => {
    syncNav(nav);
    nav.addEventListener("click", (event) => {
      const next = event.target.closest("button");
      if (!next || !nav.contains(next)) return;
      all("button", nav).forEach((button) => button.removeAttribute("aria-current"));
      next.setAttribute("aria-current", "page");
      syncNav(nav);
    });
    new ResizeObserver(() => syncNav(nav)).observe(nav);
  });

  all("[data-cmp-list]").forEach((list) => {
    list.addEventListener("click", (event) => {
      const next = event.target.closest("[aria-pressed], [role=radio]");
      if (!next || !list.contains(next)) return;
      all("[aria-pressed], [role=radio]", list).forEach((row) => {
        const selected = row === next;
        if (row.hasAttribute("aria-pressed")) row.setAttribute("aria-pressed", String(selected));
        if (row.hasAttribute("aria-checked")) row.setAttribute("aria-checked", String(selected));
      });
    });
  });

  let openRowMenu = null;
  const setRowMenuOpen = (anchor, open, restoreFocus = false) => {
    const trigger = anchor?.querySelector("[data-cmp-row-menu-trigger]");
    const menu = anchor?.querySelector(".cmp-row-menu");
    if (!trigger || !menu) return;
    if (openRowMenu && openRowMenu !== anchor) setRowMenuOpen(openRowMenu, false);
    trigger.setAttribute("aria-expanded", String(open));
    openRowMenu = open ? anchor : null;
    animatePopup(menu, open, "top right");
    if (open) requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus());
    if (!open && restoreFocus) trigger.focus();
  };

  all("[data-cmp-row-menu]").forEach((anchor) => {
    const trigger = anchor.querySelector("[data-cmp-row-menu-trigger]");
    const menu = anchor.querySelector(".cmp-row-menu");
    trigger?.addEventListener("click", () => setRowMenuOpen(anchor, trigger.getAttribute("aria-expanded") !== "true"));
    menu?.addEventListener("click", (event) => {
      if (event.target.closest('[role="menuitem"]')) setRowMenuOpen(anchor, false, true);
    });
    menu?.addEventListener("keydown", (event) => {
      const items = all('[role="menuitem"]', menu);
      const index = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        items[(index + offset + items.length) % items.length]?.focus();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setRowMenuOpen(anchor, false, true);
      }
    });
  });
  document.addEventListener("pointerdown", (event) => {
    if (openRowMenu && !openRowMenu.contains(event.target)) setRowMenuOpen(openRowMenu, false);
  });

  all("[data-cmp-reorder]").forEach((list) => {
    let dragged = null;
    const rows = () => all(".cmp-reorder-row", list);
    const update = (moved) => {
      const words = ["first", "second", "third", "fourth", "fifth"];
      rows().forEach((row, index) => {
        const number = row.querySelector(".cmp-order-number");
        const detail = row.querySelector("small");
        if (number) number.textContent = String(index + 1);
        if (detail) detail.textContent = `Runs ${words[index] || `at position ${index + 1}`}`;
      });
      const status = list.parentElement?.querySelector("[data-cmp-reorder-status]");
      if (status && moved) status.textContent = `${moved.querySelector("strong")?.textContent || "Item"} moved to position ${rows().indexOf(moved) + 1}.`;
    };
    const move = (row, direction) => {
      const items = rows();
      const index = items.indexOf(row);
      const target = items[index + direction];
      if (!target) return;
      const before = new Map(items.map((item) => [item, item.getBoundingClientRect()]));
      if (direction < 0) list.insertBefore(row, target); else list.insertBefore(target, row);
      if (!reducedMotion()) rows().forEach((item) => {
        const old = before.get(item);
        const next = item.getBoundingClientRect();
        const delta = old ? old.top - next.top : 0;
        if (delta) item.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 250, easing: "cubic-bezier(.2,.72,.24,1)" });
      });
      update(row);
      row.querySelector(".cmp-drag-handle")?.focus();
    };
    list.addEventListener("keydown", (event) => {
      const handle = event.target.closest(".cmp-drag-handle");
      if (!handle || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      move(handle.closest(".cmp-reorder-row"), event.key === "ArrowUp" ? -1 : 1);
    });
    list.addEventListener("dragstart", (event) => {
      dragged = event.target.closest(".cmp-reorder-row");
      dragged?.classList.add("is-dragging");
      event.dataTransfer?.setData("text/plain", dragged?.querySelector("strong")?.textContent || "item");
    });
    list.addEventListener("dragover", (event) => {
      event.preventDefault();
      const target = event.target.closest(".cmp-reorder-row");
      rows().forEach((row) => row.classList.toggle("is-target", row === target && row !== dragged));
      if (!dragged || !target || target === dragged) return;
      const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
      list.insertBefore(dragged, after ? target.nextSibling : target);
    });
    const finish = () => {
      if (dragged) update(dragged);
      rows().forEach((row) => row.classList.remove("is-dragging", "is-target"));
      dragged = null;
    };
    list.addEventListener("drop", (event) => { event.preventDefault(); finish(); });
    list.addEventListener("dragend", finish);
    update();
  });

  all("[data-cmp-pin]").forEach((pin) => {
    const max = Number(pin.dataset.length || 4);
    const dots = all(".cmp-pin-progress i", pin);
    const progress = pin.querySelector(".cmp-pin-progress");
    const status = pin.querySelector("[data-cmp-pin-status]");
    let digits = [];
    let timer;
    const render = () => {
      dots.forEach((dot, index) => dot.classList.toggle("is-filled", index < digits.length));
      progress?.setAttribute("aria-label", digits.length ? `${digits.length} of ${max} digits entered` : "No digits entered");
      if (pin.dataset.state !== "checking" && pin.dataset.state !== "success" && status) status.textContent = digits.length ? `${digits.length} of ${max} digits entered.` : `Enter your ${max}-digit Pin.`;
    };
    const enter = (digit) => {
      if (pin.dataset.state === "checking" || digits.length >= max) return;
      digits.push(digit);
      render();
      if (digits.length === max) {
        pin.dataset.state = "checking";
        if (status) status.textContent = "Checking Pin…";
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          pin.dataset.state = "success";
          if (status) status.textContent = "Pin accepted.";
        }, 700);
      }
    };
    const remove = () => {
      window.clearTimeout(timer);
      pin.dataset.state = "idle";
      digits = digits.slice(0, -1);
      render();
    };
    pin.addEventListener("click", (event) => {
      const digit = event.target.closest("[data-digit]");
      if (digit) enter(digit.dataset.digit);
      if (event.target.closest("[data-delete]")) remove();
    });
    pin.addEventListener("keydown", (event) => {
      if (/^\d$/.test(event.key)) { event.preventDefault(); enter(event.key); }
      if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); remove(); }
    });
    render();
  });

  let openSelect = null;
  const setSelectOpen = (select, open, restoreFocus = false) => {
    const trigger = select?.querySelector(".cmp-select-trigger");
    const options = select?.querySelector(".cmp-select-options");
    if (!trigger || !options) return;
    if (openSelect && openSelect !== select) setSelectOpen(openSelect, false);
    trigger.setAttribute("aria-expanded", String(open));
    openSelect = open ? select : null;
    animatePopup(options, open);
    if (open) requestAnimationFrame(() => options.querySelector('[role="option"][aria-selected="true"]')?.focus());
    if (!open && restoreFocus) trigger.focus();
  };

  all("[data-cmp-select]").forEach((select) => {
    const trigger = select.querySelector(".cmp-select-trigger");
    const options = select.querySelector(".cmp-select-options");
    trigger?.addEventListener("click", () => setSelectOpen(select, trigger.getAttribute("aria-expanded") !== "true"));
    trigger?.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectOpen(select, true);
      }
    });
    options?.addEventListener("click", (event) => {
      const option = event.target.closest('[role="option"]');
      if (!option || !options.contains(option)) return;
      all('[role="option"]', options).forEach((item) => item.setAttribute("aria-selected", String(item === option)));
      const value = select.querySelector("[data-cmp-select-value]");
      if (value) value.textContent = option.dataset.value || option.textContent.trim();
      setSelectOpen(select, false, true);
    });
    options?.addEventListener("keydown", (event) => {
      const items = all('[role="option"]', options);
      const index = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        items[(index + offset + items.length) % items.length]?.focus();
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectOpen(select, false, true);
      }
    });
  });

  document.addEventListener("pointerdown", (event) => {
    if (openSelect && !openSelect.contains(event.target)) setSelectOpen(openSelect, false);
  });

  all('.cmp-range input[type="range"]').forEach((range) => {
    range.addEventListener("input", () => {
      const output = range.closest(".cmp-range")?.querySelector("output");
      if (output) output.textContent = `${range.value}%`;
    });
  });

  all(".cmp-disclosures details").forEach((details) => {
    const summary = details.querySelector("summary");
    const body = details.querySelector(".cmp-disclosure-body");
    let animation;
    summary?.addEventListener("click", (event) => {
      if (!body) return;
      event.preventDefault();
      animation?.cancel();
      if (reducedMotion()) {
        details.open = !details.open;
        return;
      }
      body.style.overflow = "hidden";
      const closing = details.open;
      if (!closing) {
        details.open = true;
        const height = body.scrollHeight;
        animation = body.animate(
          [{ height: "0px", opacity: 0, transform: "translateY(-5px)" }, { height: `${height}px`, opacity: 1, transform: "translateY(0)" }],
          { duration: 250, easing: "cubic-bezier(.2,.72,.24,1)" },
        );
      } else {
        const height = body.getBoundingClientRect().height;
        animation = body.animate(
          [{ height: `${height}px`, opacity: 1, transform: "translateY(0)" }, { height: "0px", opacity: 0, transform: "translateY(-4px)" }],
          { duration: 150, easing: "ease-in" },
        );
      }
      animation.finished.catch(() => {}).then(() => {
        if (closing) details.open = false;
        body.style.removeProperty("overflow");
        body.style.removeProperty("height");
      });
    });
  });

  const menuButton = document.querySelector("[data-cmp-menu-button]");
  const menu = document.querySelector("[data-cmp-menu]");
  const setMenuOpen = (open, restoreFocus = false) => {
    if (!menuButton || !menu) return;
    menuButton.setAttribute("aria-expanded", String(open));
    animatePopup(menu, open, "top left");
    if (open) requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus());
    if (!open && restoreFocus) menuButton.focus();
  };

  menuButton?.addEventListener("click", () => setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true"));
  menu?.addEventListener("click", (event) => {
    if (event.target.closest('[role="menuitem"]')) setMenuOpen(false, true);
  });
  menu?.addEventListener("keydown", (event) => {
    const items = all('[role="menuitem"]', menu);
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      items[(index + offset + items.length) % items.length]?.focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false, true);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu || menu.hidden || menu.contains(event.target) || menuButton?.contains(event.target)) return;
    setMenuOpen(false);
  });

  const dialog = document.querySelector("[data-cmp-dialog]");
  const openDialogButton = document.querySelector("[data-cmp-dialog-open]");
  const closeDialog = (value = "cancel") => {
    if (!dialog?.open) return;
    if (reducedMotion()) {
      dialog.close(value);
      return;
    }
    dialog.classList.add("is-closing");
    const mobile = window.matchMedia("(max-width: 620px)").matches;
    const animation = dialog.animate(
      [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: mobile ? "translateY(28px) scale(1)" : "translateY(8px) scale(.98)" }],
      { duration: 150, easing: "ease-in" },
    );
    animation.finished.catch(() => {}).then(() => {
      dialog.classList.remove("is-closing");
      dialog.close(value);
      openDialogButton?.focus();
    });
  };
  openDialogButton?.addEventListener("click", () => {
    dialog?.showModal();
    if (!dialog || reducedMotion()) return;
    const mobile = window.matchMedia("(max-width: 620px)").matches;
    dialog.animate(
      [{ opacity: 0, transform: mobile ? "translateY(34px) scale(1)" : "translateY(10px) scale(.97)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
      { duration: 250, easing: "cubic-bezier(.2,.72,.24,1)" },
    );
  });
  dialog?.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    closeDialog(event.submitter?.value || "confirm");
  });
  dialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog("cancel");
  });
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog("cancel");
  });

  const toast = document.querySelector("[data-cmp-toast]");
  let toastTimer;
  const hideToast = () => {
    window.clearTimeout(toastTimer);
    animatePopup(toast, false, "bottom right");
  };
  const showToast = () => {
    animatePopup(toast, true, "bottom right");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, 4200);
  };
  document.querySelector("[data-cmp-toast-open]")?.addEventListener("click", showToast);
  document.querySelector("[data-cmp-toast-close]")?.addEventListener("click", hideToast);

  document.querySelector("[data-cmp-save]")?.addEventListener("click", (event) => {
    const editor = event.currentTarget.closest("[data-cmp-editor]");
    const label = editor?.querySelector(".cmp-dirty-label");
    if (editor) editor.dataset.state = "saved";
    if (label) label.textContent = "Saved";
    event.currentTarget.textContent = "Saved";
    if (!reducedMotion()) event.currentTarget.animate([{ transform: "scale(.97)" }, { transform: "scale(1.02)" }, { transform: "scale(1)" }], { duration: 250 });
    window.setTimeout(() => { event.currentTarget.textContent = "Save"; }, 1400);
  });

  document.querySelector("[data-cmp-retry]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const banner = button.closest(".cmp-stale-banner");
    if (banner) banner.dataset.state = "checking";
    button.disabled = true;
    button.textContent = "Checking…";
    window.setTimeout(() => {
      if (banner) banner.dataset.state = "idle";
      button.disabled = false;
      button.textContent = "Retry";
    }, 1200);
  });

  const swapEditor = (editor, editing) => {
    const read = editor.querySelector(".cmp-inline-editor__read");
    const form = editor.querySelector(".cmp-inline-editor__form");
    const outgoing = editing ? read : form;
    const incoming = editing ? form : read;
    const finish = () => {
      outgoing.hidden = true;
      incoming.hidden = false;
      if (!reducedMotion()) incoming.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 250, easing: "cubic-bezier(.2,.72,.24,1)" });
      incoming.querySelector("input, button")?.focus();
    };
    if (reducedMotion()) finish();
    else outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100 }).finished.catch(() => {}).then(finish);
  };
  all("[data-cmp-inline-editor]").forEach((editor) => {
    editor.querySelector("[data-cmp-edit]")?.addEventListener("click", () => swapEditor(editor, true));
    editor.querySelector("[data-cmp-edit-cancel]")?.addEventListener("click", () => swapEditor(editor, false));
    editor.querySelector("[data-cmp-edit-save]")?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      button.textContent = "Saving…";
      button.disabled = true;
      window.setTimeout(() => {
        button.textContent = "Save key";
        button.disabled = false;
        swapEditor(editor, false);
      }, 650);
    });
  });

  all("[data-cmp-stepper]").forEach((stepper) => {
    const steps = all(".cmp-stepper li", stepper);
    const count = stepper.querySelector("[data-cmp-step-count]");
    const back = stepper.querySelector("[data-cmp-step-back]");
    const next = stepper.querySelector("[data-cmp-step-next]");
    let current = Math.max(0, steps.findIndex((step) => step.dataset.state === "current"));
    const render = () => {
      steps.forEach((step, index) => {
        step.dataset.state = index < current ? "complete" : index === current ? "current" : "upcoming";
        if (index === current) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
        const icon = step.querySelector("i");
        if (icon) icon.innerHTML = index < current ? '<svg><use href="#i-check"></use></svg>' : String(index + 1);
        const detail = step.querySelector("small");
        if (detail) detail.textContent = index < current ? "Complete" : index === current ? "Current step" : "Not started";
      });
      if (count) count.textContent = `Step ${current + 1} of ${steps.length}`;
      if (back) back.disabled = current === 0;
      if (next) next.textContent = current === steps.length - 1 ? "Finish" : "Continue";
    };
    back?.addEventListener("click", () => { current = Math.max(0, current - 1); render(); });
    next?.addEventListener("click", () => { current = Math.min(steps.length - 1, current + 1); render(); });
    render();
  });

  all("[data-cmp-upload]").forEach((upload) => {
    const zone = upload.querySelector("[data-cmp-drop-zone]");
    const input = upload.querySelector("[data-cmp-file]");
    const name = upload.querySelector("[data-cmp-file-name]");
    const button = upload.querySelector("[data-cmp-upload-button]");
    const bar = upload.querySelector(".cmp-progress i");
    const amount = upload.querySelector(".cmp-file-row .cmp-row-meta");
    const choose = () => input?.click();
    zone?.addEventListener("click", choose);
    zone?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
    });
    ["dragenter", "dragover"].forEach((type) => zone?.addEventListener(type, (event) => { event.preventDefault(); zone.classList.add("is-dragging"); }));
    ["dragleave", "drop"].forEach((type) => zone?.addEventListener(type, (event) => { event.preventDefault(); zone.classList.remove("is-dragging"); }));
    input?.addEventListener("change", () => {
      if (input.files?.[0] && name) name.textContent = input.files[0].name;
    });
    button?.addEventListener("click", () => {
      let progress = 0;
      button.disabled = true;
      button.textContent = "Uploading…";
      if (bar) bar.style.width = "0%";
      const timer = window.setInterval(() => {
        progress = Math.min(100, progress + 8);
        if (bar) bar.style.width = `${progress}%`;
        if (amount) amount.textContent = `${progress}%`;
        if (progress === 100) {
          window.clearInterval(timer);
          button.textContent = "Uploaded";
          if (bar) bar.style.backgroundColor = "var(--color-ok)";
        }
      }, 110);
    });
  });

  document.querySelector("[data-cmp-load-more]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const list = button.closest("[data-cmp-results]")?.querySelector(".cmp-result-list");
    button.disabled = true;
    button.textContent = "Loading…";
    window.setTimeout(() => {
      const row = document.createElement("button");
      row.innerHTML = '<span class="cmp-row-icon cmp-row-icon--sage">D</span><span><strong>Guest profile</strong><small>Shared · Added just now</small></span><svg class="cmp-chevron"><use href="#i-chevron"></use></svg>';
      list?.append(row);
      if (!reducedMotion()) row.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 250, easing: "cubic-bezier(.2,.72,.24,1)" });
      button.disabled = false;
      button.textContent = "Load more";
    }, 700);
  });

  all("[data-cmp-bulk]").forEach((bulk) => {
    const master = bulk.querySelector("[data-cmp-select-all]");
    const items = all('.cmp-bulk-list input[type="checkbox"]:not(:disabled)', bulk);
    const count = bulk.querySelector("[data-cmp-selection-count]");
    const actions = all("[data-cmp-bulk-action]", bulk);
    const render = () => {
      const selected = items.filter((item) => item.checked).length;
      if (master) {
        master.checked = selected === items.length;
        master.indeterminate = selected > 0 && selected < items.length;
      }
      if (count) count.textContent = `${selected} selected`;
      actions.forEach((action) => { action.disabled = selected === 0; });
      bulk.dataset.state = selected ? "active" : "idle";
    };
    master?.addEventListener("change", () => { items.forEach((item) => { item.checked = master.checked; }); render(); });
    items.forEach((item) => item.addEventListener("change", render));
    render();
  });

  document.querySelector("#verification-code")?.addEventListener("input", (event) => {
    event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 6);
  });

  document.querySelector("[data-cmp-apply-button]")?.addEventListener("click", (event) => {
    const bar = event.currentTarget.closest("[data-cmp-apply]");
    const title = bar?.querySelector("strong");
    const detail = bar?.querySelector("small");
    if (bar) bar.dataset.state = "applying";
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = "Applying…";
    window.setTimeout(() => {
      if (bar) bar.dataset.state = "done";
      const copy = [title, detail].filter(Boolean);
      const change = () => {
        if (title) title.textContent = "Changes applied";
        if (detail) detail.textContent = "The household preference is up to date.";
        event.currentTarget.textContent = "Applied";
      };
      if (reducedMotion() || !copy.length) change();
      else Promise.all(copy.map((node) => node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: "forwards" }).finished)).then(() => {
        change();
        copy.forEach((node) => node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: "forwards" }));
      });
      showToast();
    }, 900);
  });
})();
