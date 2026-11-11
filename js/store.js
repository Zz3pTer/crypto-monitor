// Settings remembered in this browser (FR-REF-04). Every access is wrapped in
// try/catch: private windows or blocked storage just fall back to defaults.

const PREFIX = "csm.";

export function get(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the setting lasts until the page is closed */
  }
}
