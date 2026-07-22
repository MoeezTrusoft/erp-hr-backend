import { z } from "zod";

const emptyToUndefined = (value) => (value === "" || value === null ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());
const optionalEmail = z.preprocess(emptyToUndefined, z.string().trim().email().optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());
const optionalInt = z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const optionalNumber = z.preprocess(emptyToUndefined, z.coerce.number().optional());
const optionalRecord = z.record(z.string(), z.any()).optional();
const requiredString = z.preprocess(emptyToUndefined, z.string().trim().min(1));
const optionalPhone = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .regex(/^[+\d\s().-]{6,32}$/, "Phone number format is invalid")
    .optional()
);

const mediaVisibility = z.enum(["hr_only", "manager", "employee", "all"]).default("all");

// FE-supplied inline upload: a raw base64 string OR a full `data:<mime>;base64,…`
// URI. When present, the service decodes it, uploads to DAM, and extracts
// fileName/mimeType/fileSize itself — the FE no longer needs a pre-uploaded
// mediaId. Not run through the empty→undefined trim helper because base64
// payloads are large and never blank-meaningful; a plain optional string suffices.
const optionalBase64 = z.string().min(1).optional();

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
  fileBase64: optionalBase64,
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
  // FE-compat alias: some callers send `company` (int) instead of `companyId`.
  company: optionalInt,
  // FE-compat alias: some callers send a top-level `email` for the login account.
  email: optionalEmail,
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
  // Inline photo upload (base64 / data URI). If set, the service uploads to DAM
  // and derives the media id + url; the *MediaId fields above stay for callers
  // that already hold a DAM asset.
  profilePhotoBase64: optionalBase64,
  profilePhotoFileName: optionalString,
  coverPhotoBase64: optionalBase64,
  coverPhotoFileName: optionalString,
  emergencyContacts: z.array(emergencyContactSchema).optional().default([]),
  documents: z.array(employeeDocumentSchema).optional().default([]),
  additionalFields: optionalRecord,
  // Tax + banking (consolidated profile). ntn is C4-encrypted at rest. The bank
  // fields upsert the employee's PRIMARY BankDetail (no create/update path existed
  // before). Provide bankName + accountNumber together to create a bank row; any
  // subset updates the existing primary. iban is C4-encrypted at rest.
  ntn: optionalString,
  bankName: optionalString,
  accountTitle: optionalString, // A/C Title
  accountNumber: optionalString,
  iban: optionalString,
  branch: optionalString,
  disbursementMethod: optionalString, // Bank Transfer | Cheque | Cash
  routingNumber: optionalString,
  accountType: optionalString,
  // Opt-in AI resume parsing on create/update: only runs when BOTH a resumeMediaId
  // (DAM asset) and parseResume:true are supplied. See resumeParsing.service.js.
  resumeMediaId: optionalInt,
  parseResume: z.coerce.boolean().optional().default(false),
  // Single-call orchestration: when createSystemAccount is true, createEmployee
  // ALSO provisions a login User in RBAC (POST /api/employee) after the HR row
  // commits — the FE makes one call instead of two. All fields are OPTIONAL so
  // existing callers are unaffected, and none of them leak into the Employee DB
  // row (employeeDataFromContract ignores them; they are used only to build the
  // RBAC payload). systemEmail overrides the login email (falls back to
  // work/personal email); roleId + password are required for the RBAC call, else
  // provisioning is skipped. permissions are per-permission grant/deny overrides.
  createSystemAccount: z.coerce.boolean().optional().default(false),
  systemEmail: optionalEmail,
  password: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  roleId: optionalInt,
  permissions: z
    .array(z.object({ permissionId: optionalInt, granted: z.coerce.boolean().optional().default(true) }))
    .optional(),
  // FE-compat: accept EITHER the canonical array [{permissionId,granted}] OR the
  // FE's legacy map form ({"<resId>-ACTION":"SCOPE"}). Tolerant (z.any) so a map
  // no longer hard-fails (-32602); the service only applies the array form and
  // ignores a map (the role's base permissions still apply). Prefer `permissions`.
  permissionMap: z.any().optional(),
};

// Only firstName + lastName are required at create time. jobTitle, hireDate,
// employmentStatus and positionId map to NULLABLE DB columns (Employee.job_title,
// hire_date, employement_status, positionId — all `?` in prisma/schema.prisma),
// so they stay optional+nullable here to match both the DB and the advertised
// MCP inputSchema (firstName + lastName only). positionId is FK-validated by the
// service ONLY when supplied (assertEmployeeReferences). The `optional*` helpers
// already coerce "" / null → undefined, so an explicit null is accepted too.
export const createEmployeeContractSchema = z
  .object({
    ...employeeBase,
    firstName: requiredString,
    lastName: requiredString,
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
  fileBase64: optionalBase64,
  url: optionalString,
  downloadUrl: optionalString,
  fileName: optionalString,
  mimeType: optionalString,
  fileSize: optionalInt,
});

export const createEmployeeDocumentSchema = employeeDocumentSchema;

export const updateEmployeeDocumentSchema = employeeDocumentSchema.partial();
