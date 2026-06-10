import { z } from "zod";

const emptyToUndefined = (value) => (value === "" || value === null ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());
const optionalEmail = z.preprocess(emptyToUndefined, z.string().trim().email().optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());
const optionalInt = z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const optionalNumber = z.preprocess(emptyToUndefined, z.coerce.number().optional());
const optionalRecord = z.record(z.string(), z.any()).optional();
const requiredString = z.preprocess(emptyToUndefined, z.string().trim().min(1));
const requiredDate = z.preprocess(emptyToUndefined, z.coerce.date());
const requiredInt = z.preprocess(emptyToUndefined, z.coerce.number().int().positive());
const optionalPhone = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .regex(/^[+\d\s().-]{6,32}$/, "Phone number format is invalid")
    .optional()
);

const mediaVisibility = z.enum(["hr_only", "manager", "employee", "all"]).default("all");

export const emergencyContactSchema = z.object({
  id: optionalInt,
  contactName: optionalString,
  name: optionalString,
  relationship: optionalString,
  phone: optionalPhone,
  email: optionalEmail,
  isPrimary: z.coerce.boolean().optional().default(false),
});

export const employeeDocumentSchema = z.object({
  id: optionalInt,
  title: optionalString,
  category: optionalString,
  version: optionalString,
  visibility: mediaVisibility.optional(),
  effectiveDate: optionalString,
  expiryDate: optionalString,
  notes: optionalString,
  mediaId: optionalInt,
  fileName: optionalString,
  mimeType: optionalString,
  fileSize: optionalInt,
  downloadUrl: optionalString,
  status: optionalString,
});

const employeeBase = {
  firstName: optionalString,
  middleName: optionalString,
  lastName: optionalString,
  preferredName: optionalString,
  dateOfBirth: optionalDate,
  gender: optionalString,
  maritalStatus: optionalString,
  nationality: optionalString,
  nationalIdType: optionalString,
  nationalIdNumber: optionalString,
  personalEmail: optionalEmail,
  workEmail: optionalEmail,
  mobilePhone: optionalPhone,
  workPhone: optionalPhone,
  residentialAddress: optionalString,
  mailingAddress: optionalString,
  city: optionalString,
  stateProvince: optionalString,
  country: optionalString,
  postalCode: optionalString,
  employeeCode: optionalString,
  jobTitle: optionalString,
  companyId: optionalInt,
  positionId: optionalInt,
  departmentId: optionalInt,
  businessUnitId: optionalInt,
  managerId: optionalInt,
  locationId: optionalInt,
  employmentType: optionalString,
  employmentStatus: optionalString,
  hireDate: optionalDate,
  joiningDate: optionalDate,
  probationEndDate: optionalDate,
  fte: optionalNumber,
  profilePhotoMediaId: optionalInt,
  coverPhotoMediaId: optionalInt,
  emergencyContacts: z.array(emergencyContactSchema).optional().default([]),
  documents: z.array(employeeDocumentSchema).optional().default([]),
  additionalFields: optionalRecord,
};

export const createEmployeeContractSchema = z
  .object({
    ...employeeBase,
    firstName: requiredString,
    lastName: requiredString,
    jobTitle: requiredString,
    hireDate: requiredDate,
    employmentStatus: requiredString,
    positionId: requiredInt,
  })
  .superRefine((data, ctx) => {
    const primaryCount = data.emergencyContacts.filter((contact) => contact.isPrimary).length;
    if (primaryCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emergencyContacts"],
        message: "Only one emergency contact can be primary",
      });
    }
  });

export const updateEmployeeContractSchema = z.object(employeeBase).partial().superRefine((data, ctx) => {
  const primaryCount = data.emergencyContacts?.filter((contact) => contact.isPrimary).length || 0;
  if (primaryCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["emergencyContacts"],
      message: "Only one emergency contact can be primary",
    });
  }
});

export const employeeStatusSchema = z.object({
  status: z.string().trim().min(1, "Status is required"),
});

export const mediaAttachSchema = z.object({
  mediaId: optionalInt,
  url: optionalString,
  downloadUrl: optionalString,
  fileName: optionalString,
  mimeType: optionalString,
  fileSize: optionalInt,
});

export const createEmployeeDocumentSchema = employeeDocumentSchema;

export const updateEmployeeDocumentSchema = employeeDocumentSchema.partial();
