// In-app dialogs and toasts. Nothing here uses window.confirm/alert: a native
// dialog steals the whole desktop, looks nothing like the app, and on a tiling
// compositor it lands wherever the WM feels like putting it.

import { squircleAll } from "/static/squircle.js";

let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.className = "ui-host";
  document.body.append(host);
  return host;
}

/**
 * Modal confirm. Resolves true/false. Esc and backdrop click cancel; Enter
 * takes the primary action, so it is keyboard-complete without a mouse.
 */
export function confirmDialog({
  title,
  body = "",
  confirmLabel = "confirm",
  cancelLabel = "cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const panel = document.createElement("div");
    panel.className = "modal";
    panel.dataset.squircle = "";
    panel.dataset.radius = "18";
    panel.dataset.edge = "";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const h = document.createElement("div");
    h.className = "title-lg";
    h.textContent = title;

    const p = document.createElement("div");
    p.className = "modal-body dim";
    p.textContent = body;

    const row = document.createElement("div");
    row.className = "modal-actions";

    const cancel = document.createElement("button");
    cancel.className = "btn ghost";
    cancel.dataset.squircle = "";
    cancel.dataset.radius = "12";
    cancel.textContent = cancelLabel;

    const ok = document.createElement("button");
    ok.className = `btn ${danger ? "danger-solid" : "primary"}`;
    ok.dataset.squircle = "";
    ok.dataset.radius = "12";
    ok.textContent = confirmLabel;

    row.append(cancel, ok);
    panel.append(h);
    if (body) panel.append(p);
    panel.append(row);
    backdrop.append(panel);
    ensureHost().append(backdrop);
    squircleAll();

    const previous = document.activeElement;
    ok.focus();

    const close = (value) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      if (previous && previous.focus) previous.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === "Tab") {
        // Keep focus inside the dialog.
        e.preventDefault();
        (document.activeElement === ok ? cancel : ok).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.onclick = (e) => e.target === backdrop && close(false);
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
  });
}

/** A transient message in the corner. Returns a dismiss function. */
export function toast(text, { kind = "info", timeout = 4000, action } = {}) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.dataset.squircle = "";
  el.dataset.radius = "12";
  el.dataset.edge = "";

  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);

  if (action) {
    const b = document.createElement("button");
    b.className = "btn ghost tiny";
    b.dataset.squircle = "";
    b.dataset.radius = "9";
    b.textContent = action.label;
    b.onclick = () => {
      action.onClick();
      dismiss();
    };
    el.append(b);
  }

  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    ensureHost().append(stack);
  }
  stack.append(el);
  squircleAll();

  const dismiss = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}
