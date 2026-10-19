-- NFR-03 — correlation-id propagation into audit rows.
-- Additive and nullable: every existing writer (payroll, attendance, HR) keeps
-- writing unchanged; recruitment's logAction now stamps the request's
-- x-correlation-id automatically via the request context.
ALTER TABLE "Log" ADD COLUMN "correlationId" TEXT;

CREATE INDEX "Log_correlationId_idx" ON "Log"("correlationId");
