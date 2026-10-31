// People are shown by name, position and department, never by employee code alone.
// One batched read per call; callers pass codes from any number of rows.

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export const displayName = (e) =>
  clean(e?.employee_name) ||
  [clean(e?.first_name), clean(e?.last_name)].filter(Boolean).join(" ") ||
  clean(e?.preferred_name) ||
  e?.employee_code ||
  null;

export const toIdentity = (e) => ({
  code: e.employee_code,
  name: displayName(e),
  position: clean(e.Position?.title) || clean(e.job_title),
  department: clean(e.businessUnit?.name),
  photoUrl: clean(e.photo_url),
});

/** Map of employee code to identity for the given codes (unknown codes are absent). */
export async function identitiesByCode(db, tenantId, codes) {
  const wanted = [...new Set((codes ?? []).filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await db.employee.findMany({
    where: { tenant_id: tenantId, employee_code: { in: wanted } },
    select: {
      employee_code: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      preferred_name: true,
      job_title: true,
      photo_url: true,
      Position: { select: { title: true } },
      businessUnit: { select: { name: true } },
    },
  });
  return new Map(rows.map((r) => [r.employee_code, toIdentity(r)]));
}
