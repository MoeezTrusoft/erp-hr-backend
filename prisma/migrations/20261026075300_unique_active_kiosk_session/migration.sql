-- One physical workstation cannot host two candidates at once.
-- An expired but unfinalized session remains occupied until the expiry worker resolves it.
CREATE UNIQUE INDEX "CandidateTestSession_one_active_workstation"
ON "CandidateTestSession" ("tenantId", "workstationId")
WHERE status IN ('ISSUED', 'IN_PROGRESS', 'PAUSED');
