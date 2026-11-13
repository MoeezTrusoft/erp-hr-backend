import { z } from "zod";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scope = {
  site: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
  shift: z.string().max(100).optional(),
};
const sort = z.enum(["date", "employee", "status", "checkIn", "checkOut"]);
const direction = z.enum(["asc", "desc"]);
export const attendanceExportFilters = z
  .object({
    from: date,
    to: date,
    ...scope,
    q: z.string().max(50).optional(),
    status: z.string().max(50).optional(),
    sortBy: sort.optional(),
    sortDir: direction.optional(),
  })
  .strict();
export const attendanceExportInput = z
  .object({
    id: z.string().uuid(),
    filters: attendanceExportFilters,
    columns: z
      .array(
        z.enum([
          "employeeCode",
          "date",
          "calendar",
          "outcome",
          "processing",
          "checkIn",
          "checkOut",
          "decimalHours",
          "timeZone",
        ]),
      )
      .min(2)
      .max(9)
      .refine(
        (values) =>
          new Set(values).size === values.length &&
          values.includes("employeeCode") &&
          values.includes("date"),
        "Employee code and work date are required",
      ),
    format: z.enum(["csv", "pdf"]),
  })
  .strict();
export const attendanceViewFilters = z
  .object({
    ...scope,
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    day: date.optional(),
    code: z.string().max(50).optional(),
    outcome: z.string().max(50).optional(),
    category: z.enum(["absent", "late", "early", "other"]).optional(),
    caseState: z
      .enum(["PENDING", "APPROVED", "REJECTED", "RESOLVED"])
      .optional(),
    sort: sort.optional(),
    direction: direction.optional(),
    size: z.enum(["20", "50", "100"]).optional(),
  })
  .strict();
export const attendanceViewInput = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(80),
    filters: attendanceViewFilters,
  })
  .strict();
