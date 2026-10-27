import { z } from "zod";
const text = z.string().trim().max(10000);
const amountOrTerms = z.union([
  z.number().nonnegative(),
  text.refine(
    (value) =>
        !/^-\s*(?:\d|\.)/.test(value) &&
      (Number.isNaN(Number(value)) || Number(value) >= 0),
    "Amount cannot be negative",
  ),
]);
export const offerTermsSchema = z
  .object({
    probationMonths: z.number().int().min(0).max(120).nullable().optional(),
    noticePeriodDays: z.number().int().min(0).max(730).nullable().optional(),
    additionalTerms: text.nullable().optional(),
    specialClauses: z
      .union([text, z.array(text).max(50)])
      .nullable()
      .optional(),
    department: text.optional(),
    hiringManager: text.optional(),
    workLocation: text.optional(),
    jobTitle: text.optional(),
  })
  .strict();
export const offerCompensationSchema = z
  .object({
    baseSalary: z.number().positive().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    salaryFrequency: z.string().trim().min(1).max(50).optional(),
    bonus: amountOrTerms.nullable().optional(),
    allowances: amountOrTerms.nullable().optional(),
    benefits: z.array(text).max(100).optional(),
  })
  .strict();

export const offerCreateSchema = z
  .object({
    applicationId: z.coerce.number().int().positive(),
    candidateId: z.coerce.number().int().positive(),
    jobRequisitionId: z.coerce.number().int().positive(),
    employeeCategory: z.enum(["MANAGEMENT", "EMPLOYEE", "INTERNEE"]),
    employmentType: z.string().trim().min(1).max(100).optional(),
    offerType: z.string().trim().min(1).max(100).default("Standard"),
    startDate: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .nullable()
      .optional(),
    expiryDate: z.iso.datetime({ offset: true }).nullable().optional(),
    probationMonths: offerTermsSchema.shape.probationMonths,
    noticePeriodDays: offerTermsSchema.shape.noticePeriodDays,
    specialClauses: offerTermsSchema.shape.specialClauses,
    department: offerTermsSchema.shape.department,
    hiringManager: offerTermsSchema.shape.hiringManager,
    workLocation: offerTermsSchema.shape.workLocation,
    jobTitle: offerTermsSchema.shape.jobTitle,
    baseSalary: z.coerce.number().positive(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("PKR"),
    salaryFrequency: offerCompensationSchema.shape.salaryFrequency,
    bonus: offerCompensationSchema.shape.bonus,
    allowances: offerCompensationSchema.shape.allowances,
    benefits: z.array(text).max(100).default([]),
  })
  .strict();
