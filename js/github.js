// Save config/config.json back to the GitHub repository from the browser.
//
// Only people with a GitHub token that can write to this repository can save
// (a fine-grained token limited to this repo, "Contents: read and write").
// The token is entered once in the settings panel and kept in this browser
// only; it is never put in the page code or the repository.
import * as store from "./store.js";

const API = "https://api.github.com";
const TOKEN_KEY = "ghToken";

export function repoInfo(cfg) {
  const g = cfg.github ?? {};
  return { owner: g.owner, repo: g.repo, branch: g.branch ?? "main", path: "config/config.json" };
}

export const getToken = () => store.get(TOKEN_KEY, null);
export const setToken = (t) => store.set(TOKEN_KEY, t || null);

async function api(path, token, opts = {}) {
  // no-store: GitHub lets browsers reuse an answer for 60 s, which would give
  // an old version id right after a save and make the next save fail.
  const res = await fetch(API + path, {
    cache: "no-store",
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `GitHub answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Checks the token: who it belongs to and whether it may write to this repo.
export async function checkToken(cfg, token) {
  const { owner, repo } = repoInfo(cfg);
  let r;
  try {
    r = await api(`/repos/${owner}/${repo}`, token);
  } catch (e) {
    if (e.status === 401) return { ok: false, reason: "GitHub did not accept this token (wrong or expired)." };
    throw e;
  }
  const canWrite = Boolean(r.permissions?.push || r.permissions?.admin || r.permissions?.maintain);
  let login = null;
  try { login = (await api("/user", token)).login; } catch { /* fine-grained tokens may not read /user */ }
  return canWrite
    ? { ok: true, login }
    : { ok: false, login, reason: "This token cannot change files in this repository. It needs \"Contents: Read and write\" for crypto-monitor." };
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Reads the config as it is on GitHub right now (with its version id).
export async function readRemote(cfg, token) {
  const { owner, repo, branch, path } = repoInfo(cfg);
  const r = await api(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, token);
  return { sha: r.sha, text: fromBase64(r.content) };
}

// Writes the new config as one commit. `sha` must be the version the edit
// started from; if someone else saved in between, GitHub refuses (409) and
// nothing is overwritten.
export async function saveConfig(cfg, token, text, sha, message) {
  const { owner, repo, branch, path } = repoInfo(cfg);
  const r = await api(`/repos/${owner}/${repo}/contents/${path}`, token, {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(text), sha, branch }),
  });
  return { sha: r.content.sha, commitUrl: r.commit.html_url };
}

function oneLine(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(oneLine).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(", ")}}`;
}

// Readable config text: small objects and lists stay on one line
// (e.g. one line per coin), bigger ones are spread over several lines.
export function formatConfig(value, indent = "") {
  const inner = indent + "  ";
  const compact = JSON.stringify(value);
  const isContainer = value !== null && typeof value === "object";
  if (!isContainer) return compact;
  const children = Array.isArray(value) ? value : Object.values(value);
  const flat = children.every((c) => c === null || typeof c !== "object" || (Array.isArray(c) && c.every((x) => typeof x !== "object")));
  if (flat && compact.length + indent.length <= 110) return oneLine(value);
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => inner + formatConfig(v, inner)).join(",\n")}\n${indent}]`;
  }
  return `{\n${Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatConfig(v, inner)}`).join(",\n")}\n${indent}}`;
}
