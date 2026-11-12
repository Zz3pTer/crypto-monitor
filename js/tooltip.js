// "?" help pop-ups (spec 4.5, 5.4).
// Mouse: hover opens within 0.3 s, moving away closes (FR-HELP-02).
// Touch: tap opens, tapping elsewhere closes. Keyboard: Tab to the icon opens,
// Esc closes (FR-HELP-04). At most 320 px wide, never cut off by the screen
// edge, and it floats above the page so nothing else moves (FR-HELP-05).
import { helpFor } from "./help-text.js";
import * as fmt from "./format.js";

const OPEN_DELAY_MS = 150;
let pop, arrow, current = null, openTimer = null, closeTimer = null, openedByHover = false;
let ctx = { cfg: null, resolve: () => null };

export function init(cfg, resolve) {
  ctx = { cfg, resolve };
  pop = document.createElement("div");
  pop.className = "popup";
  pop.id = "help-popup";
  pop.setAttribute("role", "tooltip");
  pop.hidden = true;
  arrow = document.createElement("span");
  arrow.className = "popup-arrow";
  document.body.append(pop);

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const icon = e.target.closest?.(".help");
    if (icon) { clearTimeout(closeTimer); if (icon !== current) { clearTimeout(openTimer); openTimer = setTimeout(() => { open(icon); openedByHover = true; }, OPEN_DELAY_MS); } }
  });
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse") return;
    const icon = e.target.closest?.(".help");
    if (icon && !icon.contains(e.relatedTarget)) { clearTimeout(openTimer); closeTimer = setTimeout(close, 80); }
  });
  document.addEventListener("click", (e) => {
    const icon = e.target.closest?.(".help");
    if (icon) {
      e.preventDefault();
      e.stopPropagation();                      // do not open the card behind it
      if (current === icon) { if (openedByHover) openedByHover = false; else close(); } else open(icon);
    } else if (current && !pop.contains(e.target)) {
      close();
    }
  }, true);
  document.addEventListener("focusin", (e) => {
    const icon = e.target.closest?.(".help");
    if (icon && e.target.matches(":focus-visible")) open(icon);
  });
  document.addEventListener("focusout", (e) => { if (e.target === current) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && current) { current.focus?.(); close(); } });
  window.addEventListener("scroll", () => current && place(current), { passive: true });
  window.addEventListener("resize", () => current && place(current));
  window.addEventListener("hashchange", close);
}

function content(icon) {
  const h = helpFor(icon.dataset.help, ctx.cfg);
  if (!h) return null;
  const esc = fmt.escape;
  const ranges = h.ranges.map(([cls, text]) => `<li class="${cls}">${esc(text)}</li>`).join("");
  let now = "";
  const r = ctx.resolve(icon.dataset.sym || null);
  if (r?.res) {
    try { now = `<div class="now">Now${r.sym ? ` (${esc(r.sym)})` : ""}: ${esc(h.now(r.res, r.price))}</div>`; } catch { now = ""; }
  }
  return `<div class="ttl">${esc(h.short)} — ${esc(h.full)}</div><p>${esc(h.what)}</p><ul>${ranges}</ul>${now}`;
}

function open(icon) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  const html = content(icon);
  if (!html) return;
  openedByHover = false;
  current?.setAttribute("aria-expanded", "false");
  current = icon;
  icon.setAttribute("aria-expanded", "true");
  icon.setAttribute("aria-describedby", "help-popup");
  pop.innerHTML = html;
  pop.append(arrow);
  pop.hidden = false;
  place(icon);
}

export function close() {
  clearTimeout(openTimer);
  if (!current) return;
  current.setAttribute("aria-expanded", "false");
  current.removeAttribute("aria-describedby");
  current = null;
  pop.hidden = true;
}

// Above the icon by default; below if there is no room; always inside the screen.
function place(icon) {
  const gap = 10, margin = 8;
  const r = icon.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  pop.style.maxWidth = `${Math.min(320, vw - 2 * margin)}px`;
  pop.style.left = "0px";
  pop.style.top = "0px";
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const cx = r.left + r.width / 2;
  let left = Math.min(Math.max(cx - pw / 2, margin), vw - pw - margin);
  let top, below = false;
  if (r.top - ph - gap >= margin) top = r.top - ph - gap;
  else if (r.bottom + ph + gap <= vh - margin) { top = r.bottom + gap; below = true; }
  else { top = Math.max(margin, Math.min(vh - ph - margin, r.top - ph - gap)); }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.classList.toggle("below", below);
  arrow.style.left = `${Math.round(Math.min(Math.max(cx - left, 12), pw - 12))}px`;
}
