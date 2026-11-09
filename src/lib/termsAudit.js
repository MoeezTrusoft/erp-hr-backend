// X4: one way to audit a salary-terms change, shared by every writer of employment_terms.
// Must run inside the same transaction as the write, so a salary change never exists without its audit row.
// The actor is stamped from the request context by auditActorExtension.

const isoDay = (d) => {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(+t) ? t.toISOString().slice(0, 10) : null;
};

// Amounts at 4dp, no free text. Key is "salary", not "baseSalary": the C4 layer rewrites that key anywhere in a result.
export const termsSnapshot = (t) => ({
  termsId: t.id ?? null,
  salary: Number.isFinite(Number(t.baseSalary)) ? Number(t.baseSalary).toFixed(4) : null,
  currency: t.currency ?? null,
  payFrequency: t.payFrequency ?? null,
  effectiveFrom: isoDay(t.effectiveFrom),
});

/** `salary` is the plain amount just written (the created row may hold the encrypted envelope). */
export async function auditTermsCreated(tx, { tenantId, created, salary }) {
  const previous = await tx.employmentTerms.findFirst({
    where: { employeeId: created.employeeId, id: { not: created.id }, ...(tenantId ? { tenantId } : {}) },
    orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
  });
  await tx.payrollAuditLog.create({
    data: {
      tenantId: tenantId ?? null,
      action: "EMPLOYMENT_TERMS_CREATED",
      employeeId: created.employeeId,
      details: `Salary terms #${created.id} created, effective ${isoDay(created.effectiveFrom) ?? 'unknown'}`,
      oldValues: previous ? termsSnapshot(previous) : null,
      newValues: termsSnapshot({ ...created, baseSalary: salary }),
    },
  });
}
