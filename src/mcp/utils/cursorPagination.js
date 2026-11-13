// src/mcp/utils/cursorPagination.js
//
// API-4 — opaque keyset (cursor) pagination, added ALONGSIDE the existing
// offset/page contract so it is 100% backward-compatible. A LIST tool that
// currently returns { items, total, page, pageSize } keeps doing so; when the
// caller passes an opaque `cursor` we page by keyset on (createdAt desc, id desc)
// and additionally return a `nextCursor`. Clients that ignore `cursor`/
// `nextCursor` see no change.
//
// The cursor is an opaque base64url token — callers must treat it as a blob and
// only ever echo back a `nextCursor` we minted. The payload it wraps
// ({ createdAt, id }) is an implementation detail we may change.
//
// Keyset beats offset for deep pages (no growing OFFSET scan) and is stable
// under concurrent inserts (a row added at the head never shifts a later page).

const CURSOR_VERSION = 1;

// base64url with no padding — safe in JSON/URLs and free of +,/,= .
function b64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function b64urlDecode(token) {
  return Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/**
 * Encode a keyset cursor from a row's ordering fields.
 * @param {{ createdAt: (Date|string|number), id: (number|string) }} row
 * @returns {string} opaque token
 */
export function encodeCursor(row) {
  if (!row) return null;
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt ?? null;
  const payload = { v: CURSOR_VERSION, c: createdAt, i: row.id };
  return b64urlEncode(JSON.stringify(payload));
}

/**
 * Decode an opaque cursor token. Returns null for a missing/garbage token so a
 * bad cursor degrades to "start from the beginning" rather than throwing.
 * @param {string} token
 * @returns {{ createdAt: string|null, id: (number|string) } | null}
 */
export function decodeCursor(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const parsed = JSON.parse(b64urlDecode(token));
    if (!parsed || parsed.v !== CURSOR_VERSION) return null;
    if (parsed.i === undefined || parsed.i === null) return null;
    return { createdAt: parsed.c ?? null, id: parsed.i };
  } catch {
    return null;
  }
}

/**
 * Build the Prisma keyset WHERE fragment for (createdAt desc, id desc) paging.
 * Returns {} when there is no cursor so the caller's base WHERE is unchanged.
 *
 * The half-open predicate strictly AFTER the cursor row in a desc order is:
 *   createdAt < c  OR  (createdAt = c AND id < i)
 *
 * @param {{ createdAt: string|null, id: (number|string) } | null} decoded
 * @param {object} [opts]
 * @param {string} [opts.idField="id"]         id column name on the model
 * @param {string} [opts.createdAtField="createdAt"] timestamp column name
 * @param {(v:any)=>any} [opts.castId]         coerce the id (e.g. Number)
 * @returns {object} a Prisma `where` fragment (mergeable via AND) — or {}.
 */
export function keysetWhere(decoded, { idField = "id", createdAtField = "createdAt", castId } = {}) {
  if (!decoded) return {};
  const id = castId ? castId(decoded.id) : decoded.id;
  const createdAt = decoded.createdAt != null ? new Date(decoded.createdAt) : null;
  if (createdAt == null || Number.isNaN(createdAt.getTime())) {
    // No usable timestamp — fall back to id-only keyset.
    return { [idField]: { lt: id } };
  }
  return {
    OR: [
      { [createdAtField]: { lt: createdAt } },
      { AND: [{ [createdAtField]: createdAt }, { [idField]: { lt: id } }] },
    ],
  };
}

/**
 * Given the page of rows just fetched and the requested page size, derive the
 * nextCursor: the encoded cursor of the LAST row when a full page came back
 * (so there may be more), else null (the caller reached the end).
 *
 * @param {Array<{createdAt:any,id:any}>} rows
 * @param {number} pageSize
 * @returns {string|null}
 */
export function nextCursorFrom(rows, pageSize) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (pageSize && rows.length < pageSize) return null;
  return encodeCursor(rows[rows.length - 1]);
}
