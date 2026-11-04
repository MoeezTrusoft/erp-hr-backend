-- §369: a salary package did not reconstruct from the allowance split.
-- salary_components.value held a percent-of-basic at 4 dp, and the standard
-- split's exact values are 400/9, 100/3, 250/9 and 50/3 percent of basic:
-- 44.4444 + 33.3333 + 27.7778 + 16.6667 = 122.2222 % of basic, i.e. 55 % of the
-- package becomes 54.99999 % and a 300,000 package paid 299,999.97.
-- 8 dp keeps the residue at 0.00000001 % (a fraction of a paisa at any real
-- salary), so basic + allowances reproduce the entered total.
ALTER TABLE "salary_components"
  ALTER COLUMN "value" TYPE numeric(18,8);
