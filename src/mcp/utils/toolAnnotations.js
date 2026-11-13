// src/mcp/utils/toolAnnotations.js
//
// API-6 — standard MCP tool annotations. Every registered MCP tool advertises
// `annotations` in tools/list so a client knows how to treat it (safe to call
// speculatively, destructive, safe to retry). The MCP SDK (@modelcontextprotocol/
// sdk ^1.27.1) passes `annotations` straight through to the tools/list response
// (server/mcp.js — the ListToolsRequest handler maps `annotations: tool.annotations`).
//
// We infer the hints mechanically from the tool NAME verb so the ~230 existing
// `server.tool(...)` call sites need no edits — a single wrapper in toolRegistry.js
// injects `inferToolAnnotations(name)` for each registration. Inference is a pure
// function of the name; when a name is ambiguous we default to the SAFE, LOSSLESS
// choice (readOnly=false, destructive=false, idempotent=false) so we never
// mislead a client into treating a write as read-only or a create as retryable.
//
// Hint semantics (MCP spec ToolAnnotations):
//   readOnlyHint    — the tool does not modify its environment.
//   destructiveHint — the tool may perform destructive/irreversible updates
//                     (only meaningful when readOnlyHint is false).
//   idempotentHint  — repeated calls with the same args have no additional
//                     effect (only meaningful when readOnlyHint is false).
//
// These are HINTS: they are advisory and never change server-side behavior.

// Read verbs: the tool only reads/derives/exports and never mutates state.
// Matched as a trailing segment of the (underscore-delimited) tool name.
const READ_SUFFIXES = [
  "list",
  "get",
  "page",
  "view",
  "export",
  "search",
  "download",
  "directory",
  "summary",
  "overview",
  "preview",
  "report",
  "dashboard",
  "trend",
  "week",
  "roster",
];

// Read tools whose name doesn't end in a read verb but which are read-only by
// contract (analytics / org-chart / report reads, connectivity probes, etc.).
const READ_SUBSTRINGS = [
  "analytics",
  "org_chart",
  "_at_risk",
  "connectivity",
  "coverage",
  "manage_get",
  "manage_list",
  "profile_get",
  "quick_view",
  "_get_",
  "pending_approvals", // "…_pending_approvals" / "…_pending_approvals_list" are read lists
  "gdpr_export", // GDPR data export is a read/export, not a mutation
];

// Destructive verbs: irreversible / hard-state removals.
const DESTRUCTIVE_SUFFIXES = ["delete", "remove", "terminate", "erase"];
const DESTRUCTIVE_SUBSTRINGS = ["offboard", "_erase_", "gdpr_erase"];

// Idempotent write verbs: re-applying the same call converges to the same state
// (updates / sets / status transitions / cancels / withdrawals / decisions).
const IDEMPOTENT_SUFFIXES = [
  "update",
  "set",
  "status",
  "cancel",
  "withdraw",
  "unenroll",
  "mark_verified",
  "mark_missing",
  "sign",
  "close",
  "finalize",
];
const IDEMPOTENT_SUBSTRINGS = [
  "update_status",
  "update_stage",
  "update_progress",
  "set_outcome",
  "cost_config_set",
  "balance_update",
];

// Segment helpers — operate on the underscore-delimited name so "list" only
// matches a whole segment (never the "list" inside "specialist", etc.).
function segments(name) {
  return String(name).toLowerCase().split("_");
}

function endsWithSegment(name, suffix) {
  const s = segments(name);
  const parts = suffix.split("_");
  if (parts.length > s.length) return false;
  return parts.every((p, i) => s[s.length - parts.length + i] === p);
}

function includesToken(name, token) {
  return String(name).toLowerCase().includes(token);
}

function isRead(name) {
  if (READ_SUFFIXES.some((suf) => endsWithSegment(name, suf))) return true;
  if (READ_SUBSTRINGS.some((sub) => includesToken(name, sub))) return true;
  return false;
}

function isDestructive(name) {
  if (DESTRUCTIVE_SUFFIXES.some((suf) => endsWithSegment(name, suf))) return true;
  if (DESTRUCTIVE_SUBSTRINGS.some((sub) => includesToken(name, sub))) return true;
  return false;
}

function isIdempotentWrite(name) {
  if (IDEMPOTENT_SUFFIXES.some((suf) => endsWithSegment(name, suf))) return true;
  if (IDEMPOTENT_SUBSTRINGS.some((sub) => includesToken(name, sub))) return true;
  return false;
}

// Human title: strip the "hr_" prefix, split on underscores, Title Case.
export function titleFromName(name) {
  return String(name)
    .replace(/^hr_/, "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Infer standard MCP annotations for a tool NAME. Pure; returns a fresh object.
 * Precedence: read > destructive > idempotent-write > default-write. A tool is
 * never both readOnly and destructive/idempotent.
 *
 * @param {string} name  the registered tool name (e.g. "hr_employee_create").
 * @returns {{title:string, readOnlyHint:boolean, destructiveHint:boolean, idempotentHint:boolean}}
 */
export function inferToolAnnotations(name) {
  const title = titleFromName(name);

  if (isRead(name)) {
    return {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    };
  }

  if (isDestructive(name)) {
    // Destructive removals are treated as idempotent (deleting an already-deleted
    // entity converges to the same absent state).
    return {
      title,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    };
  }

  if (isIdempotentWrite(name)) {
    return {
      title,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    };
  }

  // Default: a non-idempotent write (create / run / submit / send / add /
  // enroll / approve / reject / generate). Safe, lossless default — clients
  // will not retry it automatically.
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  };
}
