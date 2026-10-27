-- Permit repair only of legacy unowned rows whose interview AND reviewer
-- already belong to the current company. Existing owned-row isolation remains.
-- No bypass, security-definer routine, or privilege grant is introduced.
CREATE POLICY legacy_scorecard_company_read ON public.interview_scorecards
FOR SELECT USING (
  "tenantId" IS NULL
  AND public.hr_current_tenant() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.interviews i
    JOIN public."Employee" e ON e.id = interview_scorecards."reviewerId"
    WHERE i.id = interview_scorecards."interviewId"
      AND i."tenantId" = public.hr_current_tenant()
      AND e.tenant_id = public.hr_current_tenant()
  )
);
CREATE POLICY legacy_scorecard_company_claim ON public.interview_scorecards
FOR UPDATE USING (
  "tenantId" IS NULL
  AND public.hr_current_tenant() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.interviews i
    JOIN public."Employee" e ON e.id = interview_scorecards."reviewerId"
    WHERE i.id = interview_scorecards."interviewId"
      AND i."tenantId" = public.hr_current_tenant()
      AND e.tenant_id = public.hr_current_tenant()
  )
) WITH CHECK ("tenantId" = public.hr_current_tenant());
