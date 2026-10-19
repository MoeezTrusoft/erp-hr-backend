-- Offer acceptance provisions an employee, and main requires every new employee
-- to carry a server-allocated code whose prefix comes from an explicit category
-- (MANAGEMENT, EMPLOYEE, INTERNEE). The category is chosen when the offer is
-- accepted and stored here, so the hire handoff and any retry of a failed
-- handoff allocate the same kind of code.
--
-- Additive and nullable: offers that were never accepted keep NULL. The column
-- is not in the HR Approval Centre's reviewed-field list, so setting it at
-- acceptance does not alter approved offer content.
ALTER TABLE "offers" ADD COLUMN "employeeCategory" "EmploymentCategory";
