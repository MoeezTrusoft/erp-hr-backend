// T1: attendance setup (policy, deduction rules, approval levels) decides how people are judged, priced
// and who approves. Every real change leaves an append-only payroll audit row (who via auditActorExtension,
// which fields, old and new), written in the SAME transaction as the change. A save that changes nothing
// is detected here so callers can skip it: it must not bump the version or flip a published row to DRAFT.

export const plain = (v) => (v != null && typeof v === "object" && typeof v.toNumber === "function" ? v.toNumber() : v);

export const sameValue = (a, b) => {
  const x = plain(a), y = plain(b);
  if (x == null || y == null) return x == null && y == null;
  const nx = Number(x), ny = Number(y);
  return typeof x !== "string" && typeof y !== "string" && Number.isFinite(nx) && Number.isFinite(ny) ? nx === ny : x === y;
};

export const changedKeys = (before, data) => Object.keys(data).filter((k) => !sameValue(before?.[k], data[k]));
export const pickPlain = (row, keys) => Object.fromEntries(keys.map((k) => [k, plain(row?.[k]) ?? null]));

/** Writes the audit row for one setup change. `before` null = created (old values come from `defaults`). */
export function auditSetupChange(tx, { tenantId, action, label, before, defaults = null, after, keys, extraOld = {}, extraNew = {} }) {
  const base = before ?? defaults;
  return tx.payrollAuditLog.create({
    data: {
      tenantId,
      action,
      details: `${label}: ${keys.length ? keys.join(", ") : "stored with defaults"}`,
      oldValues: before === null && defaults === null ? null : { ...extraOld, ...pickPlain(base, keys) },
      newValues: { ...extraNew, ...pickPlain(after, keys) },
    },
  });
}

/**
 * A DELETE leaves no DRAFT row behind, so the screen's "unpublished changes" (derived from DRAFT rows) cannot see
 * it, yet payroll keeps using the last published snapshot. Flag it on the config meta; publishing clears it.
 */
export const markUnpublished = (tx, tenantId) =>
  tx.payrollConfigMeta.upsert({
    where: { tenantId },
    update: { hasUnpublished: true },
    create: { tenantId, hasUnpublished: true },
  });
