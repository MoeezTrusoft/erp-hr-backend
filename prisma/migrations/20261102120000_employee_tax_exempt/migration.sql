-- Per-person income-tax exemption. The engine always taxed basic salary; only earning types could be non-taxable.
-- tax_exempt=true takes no income tax for the employee (the whole package is paid untaxed). Default false: nobody changes.
ALTER TABLE "Employee" ADD COLUMN "tax_exempt" BOOLEAN NOT NULL DEFAULT false;
