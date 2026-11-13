// Parse a historical punch log (device export) into the tab-separated lines the
// capture pipeline already understands: `userId \t YYYY-MM-DD HH:mm:ss \t status`.
// Pure: no I/O, so every accepted layout is unit-tested.
import { createHash } from "node:crypto";

export const MAX_IMPORT_ROWS = 50000;

const splitLine = (line) => {
  const delimiter = line.includes("\t") ? "\t" : line.includes(";") && !line.includes(",") ? ";" : ",";
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
};

const pad = (n) => String(n).padStart(2, "0");

// Accepts ISO-like `YYYY-MM-DD HH:mm[:ss]` and day-first `DD/MM/YYYY HH:mm[:ss]`
// (the Pakistani format). Returns `YYYY-MM-DD HH:mm:ss` or null.
export function normaliseTimestamp(value) {
  const v = String(value ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${pad(m[4])}:${m[5]}:${m[6] ?? "00"}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])} ${pad(m[4])}:${m[5]}:${m[6] ?? "00"}`;
  return null;
}

const HEADER = /user|id|code|time|date|status|punch/i;

// `text`: file contents. Columns: device user ID, timestamp, optional status
// (0 = in, 1 = out as on ZK devices; blank = 0).
export function parsePunchLog(text) {
  const lines = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const rows = [];
  const errors = [];
  let start = 0;
  if (lines.length && splitLine(lines[0]).some((c) => HEADER.test(c) && !/^\d/.test(c))) start = 1;
  for (let i = start; i < lines.length; i += 1) {
    const cells = splitLine(lines[i]);
    const lineNo = i + 1;
    const id = cells[0];
    const at = normaliseTimestamp(cells[1]);
    const status = cells[2] === undefined || cells[2] === "" ? "0" : cells[2];
    if (!id || id.length > 64) errors.push({ line: lineNo, message: "Device user ID is missing or too long" });
    else if (!at) errors.push({ line: lineNo, message: "Timestamp must be YYYY-MM-DD HH:mm:ss or DD/MM/YYYY HH:mm:ss" });
    else if (!/^[0-5]$/.test(status)) errors.push({ line: lineNo, message: "Punch status must be 0 to 5" });
    else rows.push({ line: lineNo, id, at, status, raw: `${id}\t${at}\t${status}\t0\t0` });
  }
  if (rows.length > MAX_IMPORT_ROWS)
    errors.push({ line: 0, message: `A file may hold at most ${MAX_IMPORT_ROWS} punches` });
  const days = rows.map((r) => r.at.slice(0, 10)).sort();
  return {
    rows,
    errors,
    from: days[0] ?? null,
    to: days[days.length - 1] ?? null,
    ids: [...new Set(rows.map((r) => r.id))],
  };
}

// Binds a commit to exactly the file and device that were previewed.
export const importToken = (sn, rows) =>
  createHash("sha256").update(JSON.stringify([sn, rows.map((r) => r.raw)])).digest("hex");

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDay = (s) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + 86400000));
export const dayAfter = addDay;
export const isoDay = iso;
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDay(d)) out.push(d);
  return out;
}
// Collapse a sorted list of ISO days into [{from,to}] runs.
export function runs(days) {
  const out = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && addDay(last.to) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}
