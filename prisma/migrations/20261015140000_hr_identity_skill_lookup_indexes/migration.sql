-- Lookup indexes for the hr_identity_resolve (userId -> employee) and
-- hr_skill_holders_list (skill -> holders, verified first, by score) MCP tools.
-- employee_code lookups already use the (tenant_id, employee_code) unique key.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_tenant_id_userId_idx" ON "Employee"("tenant_id", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "employee_skills_tenantId_skillId_verified_score_idx" ON "employee_skills"("tenantId", "skillId", "verified", "score");
