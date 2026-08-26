-- Phase A5: Add personId to Employee (cross-tenant identity anchor)
-- The FK to Person is enforced at the application layer (cross-database),
-- not at the DB layer. Person lives in the RBAC database.

ALTER TABLE "Employee" ADD COLUMN "personId" UUID;
CREATE INDEX idx_employee_personid ON "Employee"("personId");
