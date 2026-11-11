// Bright / Dark switch (FR-UI-09). One click changes the whole page with no
// reload; the choice is remembered; the starting theme comes from config.
import * as store from "./store.js";

const listeners = new Set();

export function current() {
  return document.documentElement.dataset.theme === "bright" ? "bright" : "dark";
}

export function apply(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById("theme-bright")?.setAttribute("aria-pressed", String(theme === "bright"));
  document.getElementById("theme-dark")?.setAttribute("aria-pressed", String(theme === "dark"));
  for (const fn of listeners) fn(theme);
}

export function onChange(fn) { listeners.add(fn); }

export function init(cfg) {
  apply(store.get("theme") || cfg.theme?.default || "dark");
  for (const [id, theme] of [["theme-bright", "bright"], ["theme-dark", "dark"]]) {
    document.getElementById(id).addEventListener("click", () => { store.set("theme", theme); apply(theme); });
  }
}
