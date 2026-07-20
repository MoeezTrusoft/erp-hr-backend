import prisma from "../config/prisma.js";
import logger from "../lib/logger.js";
import { getDamAssetById, normalizeDamAssetResponse, uploadFileToDAM } from "./dam.media.service.js";
import { logAction } from "../utils/logs.js";
import {
  enqueueEmployeeLifecycle,
  mapEmployeeToLifecycleInput,
} from "./employeeOutbox.service.js";
import { buildListPayload, parseListQuery, toInt } from "../utils/apiContract.js";
import { exportRows } from "../lib/export.util.js";
import { scopedEmployeeWhere, scopedWhere, scopedData } from "../lib/tenancy.js";
import {
  createEmployeeContractSchema,
  createEmployeeDocumentSchema,
  emergencyContactSchema,
  employeeStatusSchema,
  mediaAttachSchema,
  updateEmployeeContractSchema,
  updateEmployeeDocumentSchema,
} from "../validators/hrEmployeeContract.schema.js";

const employeeName = (employee) =>
  employee?.employee_name ||
  [employee?.first_name, employee?.middle_name, employee?.last_name].filter(Boolean).join(" ") ||
  employee?.preferred_name ||
  `Employee ${employee?.id}`;

const POSITION_META_PREFIX = "__TRUSOFT_POSITION_META__:";

const parsePositionDescription = (description) => {
  if (!description || typeof description !== "string") {
    return { description: description || null, meta: {} };
  }

  if (!description.startsWith(POSITION_META_PREFIX)) {
    return { description, meta: {} };
  }

  try {
    const parsed = JSON.parse(description.slice(POSITION_META_PREFIX.length));
    return {
      description: parsed.description || null,
      meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {},
    };
  } catch {
    return { description, meta: {} };
  }
};

const buildPositionDescription = (data, existingDescription = null) => {
  const current = parsePositionDescription(existingDescription);
  const meta = {
    ...current.meta,
    companyId: data.companyId ?? current.meta.companyId,
    departmentId: data.departmentId ?? current.meta.departmentId,
    band: data.band ?? current.meta.band,
    responsibilities: data.responsibilities ?? current.meta.responsibilities,
    requirements: data.requirements ?? current.meta.requirements,
  };

  return `${POSITION_META_PREFIX}${JSON.stringify({
    description: data.description ?? current.description,
    meta: Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined)),
  })}`;
};

const compactEmployeeSelect = {
  id: true,
  employee_code: true,
  employee_name: true,
  first_name: true,
  middle_name: true,
  last_name: true,
  preferred_name: true,
  email: true,
  work_email: true,
  work_phone: true,
  personal_contact: true,
  job_title: true,
  status: true,
  employement_status: true,
  photo_url: true,
  hire_date: true,
  joining_date: true,
  created_at: true,
  updated_at: true,
  additional_fields: true,
  businessUnitId: true,
  positionId: true,
  Position: { select: { id: true, title: true, jobCode: true, isActive: true } },
  manager: { select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true } },
  businessUnit: { select: { id: true, name: true } },
  gradeLevel: { select: { id: true, name: true } },
  region: { select: { id: true, name: true } },
};

const employeeDirectoryRow = (employee) => {
  const integration =
    employee.additional_fields?.hrIntegration && typeof employee.additional_fields.hrIntegration === "object"
      ? employee.additional_fields.hrIntegration
      : {};

  return {
    id: employee.id,
    code: employee.employee_code,
    name: employeeName(employee),
    email: employee.work_email || employee.email,
    phone: employee.work_phone || employee.personal_contact,
    role: employee.job_title || employee.Position?.title,
    positionId: employee.positionId || employee.Position?.id || null,
    position: employee.Position
      ? { id: employee.Position.id, title: employee.Position.title, code: employee.Position.jobCode }
      : null,
    companyId: integration.companyId || null,
    departmentId: integration.departmentId || employee.businessUnitId || null,
    // Raw business-unit id — the value the directory's Department filter sends
    // (buildEmployeeListWhere maps departmentId -> businessUnitId).
    businessUnitId: employee.businessUnitId || null,
    department: integration.departmentName || employee.businessUnit?.name || null,
    grade: employee.gradeLevel?.name || null,
    location: employee.region?.name || null,
    manager: employee.manager
      ? { id: employee.manager.id, name: employeeName(employee.manager), role: employee.manager.job_title }
      : null,
    status: employee.status || employee.employement_status || "Active",
    avatarUrl: employee.photo_url,
    hireDate: employee.hire_date || employee.joining_date,
    updatedAt: employee.updated_at,
  };
};

const positionRow = (position) => {
  const parsed = parsePositionDescription(position.description);

  return {
    id: position.id,
    title: position.title,
    description: parsed.description,
    companyId: parsed.meta.companyId || null,
    departmentId: parsed.meta.departmentId || null,
    // `band` is a real Position column; the FE form also stashes it in the
    // description meta. Prefer the meta (latest edit) then the column so a band
    // set either way shows in the directory.
    band: parsed.meta.band ?? position.band ?? null,
    responsibilities: parsed.meta.responsibilities || "",
    requirements: parsed.meta.requirements || "",
    code: position.jobCode,
    status: position.isActive ? "Active" : "Inactive",
    isActive: position.isActive,
    filledCount: position._count?.employees || 0,
    openCount: Math.max((position._count?.JobRequisition || 0) - (position._count?.employees || 0), 0),
    requisitionCount: position._count?.JobRequisition || 0,
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
  };
};

const requisitionRow = (requisition) => ({
  id: requisition.id,
  code: `REQ-${String(requisition.id).padStart(4, "0")}`,
  title: requisition.title,
  description: requisition.description,
  departmentId: requisition.departmentId,
  department: requisition.departmentId ? `Department ${requisition.departmentId}` : null,
  manager: requisition.requestedBy ? employeeName(requisition.requestedBy) : null,
  priority: requisition.priority || "Medium",
  positionId: requisition.positionId,
  position: requisition.position
    ? { id: requisition.position.id, title: requisition.position.title, code: requisition.position.jobCode }
    : null,
  requestedBy: requisition.requestedBy
    ? { id: requisition.requestedBy.id, name: employeeName(requisition.requestedBy) }
    : null,
  approvedBy: requisition.approvedBy
    ? { id: requisition.approvedBy.id, name: employeeName(requisition.approvedBy) }
    : null,
  openings: requisition.openings,
  status: requisition.status,
  approvals: requisition.approvals?.map((approval) => ({
    id: approval.id,
    status: approval.status,
    comments: approval.comments,
    decidedAt: approval.decidedAt,
    approver: approval.approver
      ? { id: approval.approver.id, name: employeeName(approval.approver) }
      : null,
  })),
  createdAt: requisition.createdAt,
  updatedAt: requisition.updatedAt,
});

const listOrder = (sort, order, fallback, allowed) => {
  const field = allowed.includes(sort) ? sort : fallback;
  return { [field]: order };
};

const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeContractPayload = (payload = {}) => ({
  ...payload,
  emergencyContacts: parseJsonArray(payload.emergencyContacts),
  documents: parseJsonArray(payload.documents),
});

const requireRecord = async (model, id, label) => {
  if (!id) return;
  const record = await prisma[model].findUnique({ where: { id: Number(id) }, select: { id: true } });
  if (!record) throw new Error(`${label} ID ${id} does not exist`);
};

const requireActivePosition = async (id) => {
  if (!id) return;
  const position = await prisma.position.findUnique({
    where: { id: Number(id) },
    select: { id: true, isActive: true, title: true },
  });
  if (!position) throw new Error(`Position ID ${id} does not exist`);
  if (!position.isActive) {
    throw new Error(`Position "${position.title}" is inactive and cannot be assigned`);
  }
};

const assertEmployeeReferences = async (data, currentEmployeeId = null) => {
  if (data.positionId) {
    const current = currentEmployeeId
      ? await prisma.employee.findUnique({
          where: { id: Number(currentEmployeeId) },
          select: { positionId: true },
        })
      : null;
    if (!current || Number(current.positionId) !== Number(data.positionId)) {
      await requireActivePosition(data.positionId);
    }
  }
  await requireRecord("region", data.locationId, "Location");

  if (data.managerId) {
    if (currentEmployeeId && Number(data.managerId) === Number(currentEmployeeId)) {
      throw new Error("Manager cannot be the same employee");
    }
    await requireRecord("employee", data.managerId, "Manager");
  }
};

const calculateTenureMonths = (hireDate) => {
  if (!hireDate) return null;
  const now = new Date();
  const start = new Date(hireDate);
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return String(Math.max(months, 0));
};

const employeeDataFromContract = (data, actorId, existing = {}) => {
  const update = {
    first_name: data.firstName,
    middle_name: data.middleName,
    last_name: data.lastName,
    preferred_name: data.preferredName,
    date_of_birth: data.dateOfBirth,
    gender: data.gender,
    marital_status: data.maritalStatus,
    nationality: data.nationality,
    nationality_id_type: data.nationalIdType,
    nationality_id_no: data.nationalIdNumber,
    email: data.personalEmail,
    work_email: data.workEmail,
    personal_contact: data.mobilePhone,
    work_phone: data.workPhone,
    current_address: data.residentialAddress,
    permenant_address: data.mailingAddress,
    city: data.city,
    state: data.stateProvince,
    province: data.stateProvince,
    country: data.country,
    postal_code: data.postalCode,
    employee_code: data.employeeCode,
    job_title: data.jobTitle,
    positionId: data.positionId,
    businessUnitId: data.businessUnitId,
    managerId: data.managerId,
    regionId: data.locationId,
    ntn: data.ntn, // C4-encrypted at rest by the prisma extension
    employee_type: data.employmentType,
    employement_status: data.employmentStatus,
    status: data.employmentStatus,
    hire_date: data.hireDate,
    joining_date: data.joiningDate,
    probation_end_date: data.probationEndDate,
    fte: data.fte,
    employee_media_id: data.profilePhotoMediaId,
    cover_photo_media_id: data.coverPhotoMediaId,
    photo_url: data.profilePhotoUrl,
    cover_photo_url: data.coverPhotoUrl,
    updatedById: actorId ? Number(actorId) : undefined,
  };

  const additionalFields =
    existing.additional_fields && typeof existing.additional_fields === "object" ? existing.additional_fields : {};
  const hrIntegration = {
    ...(additionalFields.hrIntegration && typeof additionalFields.hrIntegration === "object"
      ? additionalFields.hrIntegration
      : {}),
    companyId: data.companyId,
    departmentId: data.departmentId,
  };
  update.additional_fields = {
    ...additionalFields,
    employeeForm:
      data.additionalFields && typeof data.additionalFields === "object"
        ? {
            ...(additionalFields.employeeForm && typeof additionalFields.employeeForm === "object"
              ? additionalFields.employeeForm
              : {}),
            ...data.additionalFields,
          }
        : additionalFields.employeeForm,
    hrIntegration: Object.fromEntries(Object.entries(hrIntegration).filter(([, value]) => value !== undefined)),
  };

  if (data.hireDate) update.tenureMonths = calculateTenureMonths(data.hireDate);
  if (actorId && !existing.id) update.createdById = Number(actorId);

  const firstName = data.firstName ?? existing.first_name;
  const middleName = data.middleName ?? existing.middle_name;
  const lastName = data.lastName ?? existing.last_name;
  const name = [firstName, middleName, lastName].filter(Boolean).join(" ");
  if (name) update.employee_name = name;

  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
};

// Collect the primary-BankDetail fields present in a contract payload. Returns
// null when none are supplied so create/update can skip banking entirely.
// accountNumber / iban are C4-encrypted transparently on write.
const bankFieldsFromContract = (data) => {
  const map = {
    bankName: data.bankName,
    accountTitle: data.accountTitle,
    accountNumber: data.accountNumber,
    iban: data.iban,
    branch: data.branch,
    disbursementMethod: data.disbursementMethod,
    routingNumber: data.routingNumber,
    accountType: data.accountType,
  };
  const present = Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined));
  return Object.keys(present).length ? present : null;
};

// Upsert the employee's PRIMARY BankDetail inside a transaction. A NEW row needs
// both bankName + accountNumber (NOT NULL columns); a partial patch updates the
// existing primary. Returns true if a write happened.
const upsertPrimaryBankDetail = async (tx, employeeId, tenantId, bank) => {
  if (!bank) return false;
  const existing = await tx.bankDetail.findFirst({
    where: { employeeId: Number(employeeId), isPrimary: true },
    orderBy: { created_at: "desc" },
    select: { id: true },
  });

  if (existing) {
    await tx.bankDetail.update({ where: { id: existing.id }, data: bank });
    return true;
  }

  if (!bank.bankName || !bank.accountNumber) {
    // Can't create a new bank row without the NOT NULL fields; skip silently so
    // a partial update on an employee with no bank row is a no-op, not a 500.
    return false;
  }
  await tx.bankDetail.create({
    data: {
      employeeId: Number(employeeId),
      tenantId: tenantId ?? null,
      isPrimary: true,
      accountType: bank.accountType || "CHECKING",
      ...bank,
    },
  });
  return true;
};

const employeeProfileSelect = {
  ...compactEmployeeSelect,
  ntn: true,
  bankDetails: {
    orderBy: [{ isPrimary: "desc" }, { created_at: "desc" }],
    take: 1,
  },
  date_of_birth: true,
  nationality: true,
  nationality_id_type: true,
  nationality_id_no: true,
  marital_status: true,
  current_address: true,
  permenant_address: true,
  city: true,
  state: true,
  province: true,
  country: true,
  postal_code: true,
  employee_type: true,
  probation_end_date: true,
  fte: true,
  tenureMonths: true,
  businessUnitId: true,
  positionId: true,
  managerId: true,
  regionId: true,
  employee_media_id: true,
  cover_photo_url: true,
  cover_photo_media_id: true,
  emergencyContact: true,
  employee_media: { orderBy: { id: "desc" } },
  teamMembers: { select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true } },
  reports: { select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true } },
};

const maskTail = (v) => {
  const s = String(v ?? "");
  return s ? `****${s.slice(-4)}` : null;
};

const employeeContractProfile = (employee) => {
  const summary = employeeDirectoryRow(employee);
  const additionalFields =
    employee.additional_fields && typeof employee.additional_fields === "object" ? employee.additional_fields : {};
  // Primary bank row (C4-decrypted on read); account/iban masked here since this
  // profile is gated on hr:employee (not hr:payroll). The full-detail, permission
  // -gated view lives in the consolidated hr_employee_profile_get tool.
  const primaryBank = employee.bankDetails?.[0] || null;
  return {
  summary,
  ntn: employee.ntn ? maskTail(employee.ntn) : null,
  banking: primaryBank
    ? {
        id: primaryBank.id,
        accountTitle: primaryBank.accountTitle ?? null,
        bankName: primaryBank.bankName ?? null,
        accountNumber: maskTail(primaryBank.accountNumber),
        iban: maskTail(primaryBank.iban),
        branch: primaryBank.branch ?? null,
        disbursementMethod: primaryBank.disbursementMethod ?? null,
        accountType: primaryBank.accountType ?? null,
        isPrimary: primaryBank.isPrimary,
      }
    : null,
  personal: {
    firstName: employee.first_name,
    middleName: employee.middle_name,
    lastName: employee.last_name,
    preferredName: employee.preferred_name,
    dateOfBirth: employee.date_of_birth,
    gender: employee.gender,
    maritalStatus: employee.marital_status,
    nationality: employee.nationality,
    nationalIdType: employee.nationality_id_type,
    nationalIdNumber: employee.nationality_id_no,
  },
  contact: {
    personalEmail: employee.email,
    workEmail: employee.work_email,
    mobilePhone: employee.personal_contact,
    workPhone: employee.work_phone,
    residentialAddress: employee.current_address,
    mailingAddress: employee.permenant_address,
    city: employee.city,
    stateProvince: employee.province || employee.state,
    country: employee.country,
    postalCode: employee.postal_code,
  },
  employment: {
    employeeCode: employee.employee_code,
    jobTitle: employee.job_title,
    positionId: employee.positionId,
    departmentId: summary.departmentId || employee.businessUnitId,
    managerId: employee.managerId,
    locationId: employee.regionId,
    employmentType: employee.employee_type,
    employmentStatus: employee.status || employee.employement_status,
    hireDate: employee.hire_date,
    joiningDate: employee.joining_date,
    probationEndDate: employee.probation_end_date,
    fte: employee.fte,
    tenure: employee.tenureMonths,
  },
  overview: {
    dateOfBirth: employee.date_of_birth,
    nationality: employee.nationality,
    maritalStatus: employee.marital_status,
    address: employee.current_address,
    city: employee.city,
    country: employee.country,
    employeeType: employee.employee_type,
    fte: employee.fte,
    tenure: employee.tenureMonths,
  },
  media: {
    profilePhotoMediaId: employee.employee_media_id,
    profilePhotoUrl: employee.photo_url,
    coverPhotoMediaId: employee.cover_photo_media_id,
    coverPhotoUrl: employee.cover_photo_url,
  },
  additionalFields,
  emergencyContacts: employee.emergencyContact?.map(emergencyContactRow) || [],
  documents: employee.employee_media?.map(employeeDocumentRow) || [],
  org: {
    manager: employee.manager
      ? { id: employee.manager.id, name: employeeName(employee.manager), role: employee.manager.job_title }
      : null,
    reports: employee.reports?.map((report) => ({ id: report.id, name: employeeName(report), role: report.job_title })),
    teamMembers: employee.teamMembers?.map((member) => ({ id: member.id, name: employeeName(member), role: member.job_title })),
  },
};
};

const employeeDocumentRow = (document) => ({
  id: document.id,
  title: document.title,
  category: document.category,
  version: document.version,
  visibility: document.visibility,
  effectiveDate: document.effective_date,
  expiryDate: document.expiry_date,
  notes: document.notes,
  mediaId: document.media_id,
  fileName: document.file_name,
  mimeType: document.mime_type,
  fileSize: document.file_size,
  downloadUrl: document.download_url,
  uploadedBy: document.uploaded_by_id,
  uploadedAt: document.uploaded_at,
  status: document.status,
});

const emergencyContactRow = (contact) => ({
  id: contact.id,
  contactName: contact.Contact_name,
  relationship: contact.relationship,
  phone: contact.phone,
  email: contact.email,
  isPrimary: contact.is_primary,
});

const mediaUrl = (asset, fallbackUrl = null) =>
  asset?.file_url || asset?.url || asset?.download_url || asset?.cdn_url || fallbackUrl || null;

const mediaFileName = (asset, file, fallback = null) =>
  asset?.file_name || asset?.filename || asset?.originalname || file?.originalname || fallback || null;

const normalizeMediaPayload = async ({ mediaId, file, type, fallback = {} }) => {
  if (file) {
    const uploaded = await uploadFileToDAM(file, type);
    const asset = normalizeDamAssetResponse(uploaded);
    if (!asset?.id) throw new Error("Failed to upload media");
    return {
      mediaId: Number(asset.id),
      url: mediaUrl(asset),
      fileName: mediaFileName(asset, file),
      mimeType: asset.mime_type || asset.mimetype || file.mimetype || null,
      fileSize: Number(asset.file_size || asset.size || file.size || 0) || null,
      asset,
    };
  }

  if (mediaId) {
    const asset = await getDamAssetById(mediaId);
    return {
      mediaId: Number(mediaId),
      url: mediaUrl(asset, fallback.url || fallback.downloadUrl),
      fileName: mediaFileName(asset, null, fallback.fileName),
      mimeType: asset?.mime_type || fallback.mimeType || null,
      fileSize: Number(asset?.file_size || asset?.size || fallback.fileSize || 0) || null,
      asset,
    };
  }

  if (fallback.url || fallback.downloadUrl) {
    return {
      mediaId: null,
      url: fallback.url || fallback.downloadUrl,
      fileName: fallback.fileName || null,
      mimeType: fallback.mimeType || null,
      fileSize: Number(fallback.fileSize || 0) || null,
      asset: null,
    };
  }

  return null;
};

// Decode a FE-supplied inline upload (raw base64 OR a `data:<mime>;base64,…`
// URI) into the multer-style file object uploadFileToDAM expects, so the FE can
// send the raw bytes and the BE extracts fileName/mimeType/fileSize itself.
// Accepts either a bare string or an object carrying { fileBase64, fileName,
// mimeType }. Returns null when there is no usable base64 content.
// Filename-extension → MIME, used to give DAM a correct content-type when the
// caller supplies a plain base64 string (no data: URI) and no explicit mimeType.
// Without this, every such upload was stored as application/octet-stream.
const EXT_MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
};

const mimeFromName = (name) => {
  const ext = String(name || "").toLowerCase().split(".").pop();
  return EXT_MIME[ext] || null;
};

export const fileFromBase64 = (input, fallbackName = "upload.bin") => {
  if (!input) return null;
  const raw = typeof input === "string" ? input : input.fileBase64 || input.base64;
  if (!raw || typeof raw !== "string") return null;

  let mimetype = typeof input === "object" ? input.mimeType || input.mimetype : null;
  let b64 = raw.trim();
  const dataUri = b64.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(?:;base64)?,(.*)$/s);
  if (dataUri) {
    if (dataUri[1] && !mimetype) mimetype = dataUri[1];
    b64 = dataUri[2];
  }
  b64 = b64.replace(/\s/g, "");
  if (!b64) return null;

  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length) return null;

  const originalname =
    (typeof input === "object" && (input.fileName || input.filename)) || fallbackName;
  // Prefer an explicit/data-URI mime; otherwise infer from the filename extension
  // so DAM stores the real content-type (e.g. application/pdf for resumes).
  return {
    buffer,
    originalname,
    mimetype: mimetype || mimeFromName(originalname) || "application/octet-stream",
    size: buffer.length,
  };
};

// Resolve an employee media slot from EITHER an inline base64 upload OR a
// pre-existing DAM mediaId. base64 wins when both are present.
const resolveEmployeeMedia = async (base64Input, mediaId, type, fallback = {}) => {
  const file = fileFromBase64(base64Input, `${type}.bin`);
  if (file) return normalizeMediaPayload({ file, type });
  if (mediaId) return normalizeMediaPayload({ mediaId, type, fallback });
  return null;
};

const documentDataFromContract = (document, employeeId, actorId, media = null) => ({
  title: document.title || media?.fileName || null,
  category: document.category || null,
  version: document.version || null,
  visibility: document.visibility || "all",
  effective_date: document.effectiveDate || null,
  expiry_date: document.expiryDate || null,
  notes: document.notes || null,
  employee_id: Number(employeeId),
  media_id: media?.mediaId || document.mediaId || null,
  file_name: media?.fileName || document.fileName || null,
  mime_type: media?.mimeType || document.mimeType || null,
  file_size: media?.fileSize || document.fileSize || null,
  download_url: media?.url || document.downloadUrl || null,
  uploaded_by_id: actorId ? Number(actorId) : null,
  status: document.status || "active",
});

export const getDashboardWidgetCatalog = async () => ({
  items: [
    { id: "headcount-summary", title: "Headcount Summary", permission: "hr:employee", defaultSize: "md" },
    { id: "hiring-overview", title: "Hiring Overview", permission: "hr:recruitment", defaultSize: "md" },
    { id: "attendance-leave", title: "Attendance and Leave", permission: "hr:attendance", defaultSize: "lg" },
    { id: "payroll-summary", title: "Payroll Summary", permission: "hr:payroll", defaultSize: "md" },
    { id: "performance-summary", title: "Performance Summary", permission: "hr:performance", defaultSize: "md" },
    { id: "document-expiry", title: "Document Expiry Alerts", permission: "hr:compliance", defaultSize: "md" },
  ],
});

export const getDashboardSummary = async () => {
  const [employees, activeEmployees, positions, requisitions, pendingRequisitions] = await Promise.all([
    prisma.employee.count(),
    prisma.employee.count({
      where: { OR: [{ status: "Active" }, { employement_status: "Active" }] },
    }),
    prisma.position.count({ where: { isActive: true } }),
    prisma.jobRequisition.count(),
    prisma.jobRequisition.count({ where: { status: "PENDING_APPROVAL" } }),
  ]);

  return {
    widgets: {
      headcountSummary: { total: employees, active: activeEmployees },
      positions: { active: positions },
      recruitment: { totalRequisitions: requisitions, pendingApproval: pendingRequisitions },
    },
  };
};

export const getDashboardLayout = async (employeeId) => {
  if (!employeeId) return { widgets: [], updatedAt: null };

  const employee = await prisma.employee.findUnique({
    where: { id: Number(employeeId) },
    select: { additional_fields: true },
  });

  return employee?.additional_fields?.dashboardLayout || { widgets: [], updatedAt: null };
};

export const saveDashboardLayout = async (employeeId, layout) => {
  if (!employeeId) throw new Error("Employee context is required to save dashboard layout");

  const employee = await prisma.employee.findUnique({
    where: { id: Number(employeeId) },
    select: { additional_fields: true },
  });

  if (!employee) throw new Error("Employee not found");

  const additionalFields =
    employee.additional_fields && typeof employee.additional_fields === "object"
      ? employee.additional_fields
      : {};
  const dashboardLayout = {
    widgets: Array.isArray(layout?.widgets) ? layout.widgets : [],
    updatedAt: new Date().toISOString(),
  };

  await prisma.employee.update({
    where: { id: Number(employeeId) },
    data: { additional_fields: { ...additionalFields, dashboardLayout } },
  });

  return dashboardLayout;
};

// BLOCKER-1 / C.2 — the verified tenant (req.user.tenantId → tenantId param) is
// folded into the where via scopedEmployeeWhere so the directory NEVER returns
// another tenant's (or null-tenant) employees. Employee carries the snake_case
// `tenant_id` column (REQ-007). `undefined` keeps the legacy unscoped path for
// back-compat; a present value (incl. null) is fail-closed.
// Shared WHERE builder for the directory list AND export so the two never
// drift. Supports search (q), status, position, department, and a joining-date
// range (joinedFrom/joinedTo, matched against hire_date OR joining_date).
const buildEmployeeListWhere = (query, tenantId, q) => {
  const filters = {
    status: query.status || null,
    positionId: toInt(query.positionId),
    departmentId: toInt(query.departmentId),
    joinedFrom: query.joinedFrom ? new Date(query.joinedFrom) : null,
    joinedTo: query.joinedTo ? new Date(query.joinedTo) : null,
  };
  const range = {};
  if (filters.joinedFrom && !Number.isNaN(filters.joinedFrom.getTime())) range.gte = filters.joinedFrom;
  if (filters.joinedTo && !Number.isNaN(filters.joinedTo.getTime())) range.lte = filters.joinedTo;
  const dateFilter = Object.keys(range).length
    ? { OR: [{ hire_date: range }, { joining_date: range }] }
    : {};

  const where = {
    AND: [
      scopedEmployeeWhere(tenantId, {}),
      q
        ? {
            OR: [
              { employee_name: { contains: q, mode: "insensitive" } },
              { first_name: { contains: q, mode: "insensitive" } },
              { last_name: { contains: q, mode: "insensitive" } },
              { employee_code: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { work_email: { contains: q, mode: "insensitive" } },
              { job_title: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
      // Column-specific search (directory per-column search boxes). Each is
      // ANDed so several columns can be searched at once; each targets only its
      // own field(s), unlike the generic `q` above.
      query.nameQ
        ? {
            OR: [
              { employee_name: { contains: query.nameQ, mode: "insensitive" } },
              { first_name: { contains: query.nameQ, mode: "insensitive" } },
              { last_name: { contains: query.nameQ, mode: "insensitive" } },
              { preferred_name: { contains: query.nameQ, mode: "insensitive" } },
            ],
          }
        : {},
      query.codeQ ? { employee_code: { contains: query.codeQ, mode: "insensitive" } } : {},
      query.departmentQ
        ? { businessUnit: { is: { name: { contains: query.departmentQ, mode: "insensitive" } } } }
        : {},
      query.roleQ ? { job_title: { contains: query.roleQ, mode: "insensitive" } } : {},
      query.emailQ
        ? {
            OR: [
              { email: { contains: query.emailQ, mode: "insensitive" } },
              { work_email: { contains: query.emailQ, mode: "insensitive" } },
            ],
          }
        : {},
      query.statusQ
        ? {
            OR: [
              { status: { contains: query.statusQ, mode: "insensitive" } },
              { employement_status: { contains: query.statusQ, mode: "insensitive" } },
            ],
          }
        : {},
      query.managerQ
        ? { manager: { is: { employee_name: { contains: query.managerQ, mode: "insensitive" } } } }
        : {},
      filters.status
        ? { OR: [{ status: filters.status }, { employement_status: filters.status }] }
        : {},
      filters.positionId ? { positionId: filters.positionId } : {},
      filters.departmentId ? { businessUnitId: filters.departmentId } : {},
      dateFilter,
    ],
  };
  return { where, filters };
};

// Sort key -> Prisma orderBy. Includes relation-ordered columns (department by
// business-unit name, manager by manager name) so the directory can sort every
// visible column alphabetically. Keys are the values the frontend sends.
const EMPLOYEE_ORDER_BY = {
  created_at: (o) => ({ created_at: o }),
  updated_at: (o) => ({ updated_at: o }),
  employee_name: (o) => ({ employee_name: o }),
  employee_code: (o) => ({ employee_code: o }),
  hire_date: (o) => ({ hire_date: o }),
  department: (o) => ({ businessUnit: { name: o } }),
  role: (o) => ({ job_title: o }),
  status: (o) => ({ status: o }),
  manager: (o) => ({ manager: { employee_name: o } }),
};
const EMPLOYEE_SORTS = Object.keys(EMPLOYEE_ORDER_BY);
const buildEmployeeOrderBy = (sort, order, fallback = "created_at") =>
  (EMPLOYEE_ORDER_BY[sort] || EMPLOYEE_ORDER_BY[fallback])(order);

export const listEmployees = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "created_at" });
  const { where, filters } = buildEmployeeListWhere(query, tenantId, list.q);

  const orderBy = buildEmployeeOrderBy(list.sort, list.order, "created_at");

  const [items, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      select: compactEmployeeSelect,
      orderBy,
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.employee.count({ where }),
  ]);

  return buildListPayload({
    ...list,
    total,
    filters,
    items: items.map(employeeDirectoryRow),
  });
};

// Employee Directory export — same filters/sort as listEmployees but returns a
// CSV or PDF Buffer of ALL matching rows (capped) rather than one page.
const EMPLOYEE_EXPORT_COLUMNS = [
  { key: "code", header: "Code" },
  { key: "name", header: "Name" },
  { key: "department", header: "Department", value: (r) => r.department || "-" },
  { key: "role", header: "Position / Role", value: (r) => r.role || "-" },
  { key: "email", header: "Email", value: (r) => r.email || "-" },
  { key: "manager", header: "Manager", value: (r) => r.manager?.name || "-" },
  { key: "status", header: "Status" },
  { key: "joined", header: "Joining Date", value: (r) => (r.hireDate ? new Date(r.hireDate).toISOString().slice(0, 10) : "-") },
];

export const exportEmployees = async (query, tenantId, format = "csv") => {
  const list = parseListQuery(query, { sort: "employee_name" });
  const { where } = buildEmployeeListWhere(query, tenantId, list.q);
  const orderBy = buildEmployeeOrderBy(list.sort, list.order, "employee_name");

  const rows = await prisma.employee.findMany({
    where,
    select: compactEmployeeSelect,
    orderBy,
    take: 5000, // hard cap so an export can never run away
  });
  const items = rows.map(employeeDirectoryRow);
  const { mimeType, ext, buffer } = await exportRows(format, {
    title: "Employee Directory",
    subtitle: `${items.length} employee(s) — generated ${new Date().toISOString().slice(0, 10)}`,
    columns: EMPLOYEE_EXPORT_COLUMNS,
    rows: items,
  });
  return {
    format,
    fileName: `employee-directory-${new Date().toISOString().slice(0, 10)}.${ext}`,
    mimeType,
    count: items.length,
    base64: buffer.toString("base64"),
  };
};

export const getEmployeeQuickView = async (id, tenantId) => {
  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id: Number(id) }),
    select: {
      ...compactEmployeeSelect,
      emergencyContact: { take: 2 },
      leaveBalances: { take: 5 },
      TrainingEnrollment: { take: 5, include: { course: true } },
    },
  });

  if (!employee) throw new Error("Employee not found");

  return {
    ...employeeDirectoryRow(employee),
    emergencyContacts: employee.emergencyContact,
    leaveBalances: employee.leaveBalances,
    training: employee.TrainingEnrollment?.map((enrollment) => ({
      id: enrollment.id,
      course: enrollment.course?.title,
      status: enrollment.status,
      progress: enrollment.progress,
    })),
  };
};

// A.4 / ARCH-01 §7–§8 — emit hr.employee.lifecycle.v1 into the outbox INSIDE the
// aggregate tx so the Employee row and its lifecycle event commit or roll back
// together. Mirrors src/services/hr.service.js::emitEmployeeLifecycle so the
// MCP contract path and the REST path share ONE envelope/outbox shape. ctx
// carries the request correlationId (A.5) + acting principal so the event is
// traceable end-to-end. Fail-soft (no OutboxEvent model on the client) and
// fail-closed (no tenant) are both handled by the shared helpers; a CONTRACT
// failure throws and rolls back the surrounding tx so a bad event never escapes.
const emitEmployeeLifecycle = async (tx, employee, phase, ctx = {}, extra = {}) => {
  if (!employee) return null;
  const input = mapEmployeeToLifecycleInput(employee, phase, extra);
  // Skip emission when the tenant is unknown (fail-closed): an event with no
  // tenant cannot be contract-valid and must not break the aggregate write.
  if (!input.tenantId) return null;
  return enqueueEmployeeLifecycle(tx, {
    ...input,
    aggregateId: employee.id,
    actorId: ctx.actorId ?? extra.actorId,
    correlationId: ctx.correlationId,
  });
};

// Columns the in-tx lifecycle mapper needs to build a contract-valid event from
// the freshly-created row (tenant, identity, org unit, code, effective date).
const lifecycleSourceSelect = {
  id: true,
  tenant_id: true,
  employee_code: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  work_email: true,
  businessUnitId: true,
  positionId: true,
  status: true,
  hire_date: true,
};

export const createEmployee = async (payload, actorId, ctx = {}) => {
  const data = createEmployeeContractSchema.parse(normalizeContractPayload(payload));
  await assertEmployeeReferences(data);
  // Photos: accept an inline base64/data-URI upload OR a pre-existing mediaId.
  const profilePhoto = await resolveEmployeeMedia(
    { fileBase64: data.profilePhotoBase64, fileName: data.profilePhotoFileName },
    data.profilePhotoMediaId,
    "employee-profile-photo"
  );
  const coverPhoto = await resolveEmployeeMedia(
    { fileBase64: data.coverPhotoBase64, fileName: data.coverPhotoFileName },
    data.coverPhotoMediaId,
    "employee-cover-photo"
  );
  // Documents: upload any base64 file to DAM BEFORE the tx (network I/O must not
  // run inside a prisma transaction), resolving each to a media record. A doc is
  // valid with an inline file OR an existing mediaId.
  const documentMedia = await Promise.all(
    (data.documents || []).map(async (document) => {
      const file = fileFromBase64(document, "employee-document.bin");
      let media = null;
      if (file) {
        media = await normalizeMediaPayload({ file, type: "employee-document" });
      } else if (document.mediaId) {
        media = await normalizeMediaPayload({
          mediaId: document.mediaId,
          type: "employee-document",
          fallback: {
            fileName: document.fileName,
            mimeType: document.mimeType,
            fileSize: document.fileSize,
            url: document.downloadUrl,
          },
        });
      }
      if (!media?.mediaId) {
        throw new Error("Each employee document requires an inline file (fileBase64) or an existing mediaId");
      }
      return { document, media };
    })
  );
  // T-P2.2/T-P2.6: tenant comes ONLY from the verified claim (ctx.tenantId,
  // surfaced from the service-JWT tenant on req.user) — NEVER the request body.
  // It is an opaque RBAC Company.uuid string; thread it verbatim, null → null
  // (fail-closed). The persisted status defaults to the directory display value
  // ("Active") when the caller supplies none, so the row matches the API.
  const verifiedTenantId = ctx.tenantId != null ? ctx.tenantId : null;
  const effectiveStatus = data.employmentStatus || "Active";
  const employeeData = {
    ...data,
    employmentStatus: effectiveStatus,
    profilePhotoUrl: profilePhoto?.url,
    coverPhotoUrl: coverPhoto?.url,
  };

  const employee = await prisma.$transaction(async (tx) => {
    const createData = employeeDataFromContract(employeeData, actorId);
    createData.tenant_id = verifiedTenantId;
    const created = await tx.employee.create({
      data: createData,
      select: lifecycleSourceSelect,
    });

    // Auto-generate a stable employee code when the caller didn't supply one.
    // Uses the freshly-minted row id so it is unique + monotonic (EMP-00001).
    if (!createData.employee_code) {
      await tx.employee.update({
        where: { id: created.id },
        data: { employee_code: `EMP-${String(created.id).padStart(5, "0")}` },
      });
    }

    // A.4 / Phase 3: enqueue hr.employee.lifecycle.v1 (phase=hired) in the SAME
    // tx as the employee write, via the shared validate-before-write helper.
    await emitEmployeeLifecycle(tx, created, "hired", { ...ctx, actorId: ctx.actorId ?? actorId });

    // Phase 3: also emit onboarded event when wizard supplies an onboardingStartDate.
    // This signals IAM-provisioning consumers (RBAC user creation, access grant).
    const onboardingDate = data.additionalFields?.onboardingStartDate ?? data.onboardingStartDate ?? null;
    if (onboardingDate) {
      await emitEmployeeLifecycle(tx, created, "transferred", {
        ...ctx,
        actorId: ctx.actorId ?? actorId,
      }, { effectiveOn: onboardingDate }).catch(() => {/* non-fatal: hired already emitted */});
    }

    if (data.emergencyContacts.length > 0) {
      await tx.emergencyContacts.createMany({
        data: data.emergencyContacts.map((contact) => ({
          Contact_name: contact.contactName || contact.name || null,
          relationship: contact.relationship || null,
          phone: contact.phone || null,
          email: contact.email || null,
          is_primary: Boolean(contact.isPrimary),
          employee_Id: created.id,
        })),
      });
    }

    if (documentMedia.length > 0) {
      await tx.employeeMedia.createMany({
        data: documentMedia.map(({ document, media }) =>
          documentDataFromContract(document, created.id, actorId, media)
        ),
      });
    }

    // Banking (A/C title, bank, account #, IBAN, branch, disbursement) — no
    // create path existed before. Verified tenant rides on the row.
    await upsertPrimaryBankDetail(tx, created.id, verifiedTenantId, bankFieldsFromContract(data));

    return tx.employee.findUnique({
      where: { id: created.id },
      select: employeeProfileSelect,
    });
  });

  await logAction({
    employeeId: actorId,
    actionById: actorId,
    type: "CREATE",
    module: "Employee",
    result: "SUCCESS",
    notes: `Employee ${employee.id} created from HR contract`,
  });

  // Opt-in AI resume parsing: only when BOTH resumeMediaId + parseResume are set.
  // Best-effort enrichment — a parse failure must NOT fail employee creation.
  // The resume service is dynamically imported so its lazy AI deps are never
  // touched unless a caller opts in.
  let resumeParsing = null;
  if (data.resumeMediaId && data.parseResume) {
    try {
      const { ingestEmployeeResume } = await import("./resumeParsing.service.js");
      resumeParsing = await ingestEmployeeResume({
        employeeId: employee.id,
        mediaId: data.resumeMediaId,
        tenantId: verifiedTenantId,
        actorId,
      });
    } catch (err) {
      logger.warn(
        { err: err?.message, employeeId: employee.id },
        "createEmployee: opt-in resume parse failed (non-fatal)"
      );
      resumeParsing = { error: err?.message || "resume parse failed" };
    }
  }

  const profile = employeeContractProfile(employee);
  return resumeParsing ? { ...profile, resumeParsing } : profile;
};

export const updateEmployee = async (id, payload, actorId) => {
  const employeeId = Number(id);
  const existing = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!existing) throw new Error("Employee not found");

  const data = updateEmployeeContractSchema.parse(normalizeContractPayload(payload));
  await assertEmployeeReferences(data, employeeId);
  const profilePhoto = await resolveEmployeeMedia(
    { fileBase64: data.profilePhotoBase64, fileName: data.profilePhotoFileName },
    data.profilePhotoMediaId,
    "employee-profile-photo"
  );
  const coverPhoto = await resolveEmployeeMedia(
    { fileBase64: data.coverPhotoBase64, fileName: data.coverPhotoFileName },
    data.coverPhotoMediaId,
    "employee-cover-photo"
  );
  const employeeData = {
    ...data,
    profilePhotoUrl: profilePhoto?.url,
    coverPhotoUrl: coverPhoto?.url,
  };

  const employee = await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      data: employeeDataFromContract(employeeData, actorId, existing),
    });

    if (data.emergencyContacts?.length > 0) {
      await tx.emergencyContacts.deleteMany({ where: { employee_Id: employeeId } });
      await tx.emergencyContacts.createMany({
        data: data.emergencyContacts.map((contact) => ({
          Contact_name: contact.contactName || contact.name || null,
          relationship: contact.relationship || null,
          phone: contact.phone || null,
          email: contact.email || null,
          is_primary: Boolean(contact.isPrimary),
          employee_Id: employeeId,
        })),
      });
    }

    // Banking upsert — patch the existing primary BankDetail or create one when
    // bankName + accountNumber are supplied. Tenant inherited from the employee.
    await upsertPrimaryBankDetail(tx, employeeId, existing.tenant_id ?? null, bankFieldsFromContract(data));

    return tx.employee.findUnique({
      where: { id: employeeId },
      select: employeeProfileSelect,
    });
  });

  await logAction({
    employeeId: actorId,
    actionById: actorId,
    type: "UPDATE",
    module: "Employee",
    result: "SUCCESS",
    notes: `Employee ${employeeId} updated from HR contract`,
  });

  return employeeContractProfile(employee);
};

export const getEmployeeProfile = async (id, tenantId) => {
  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id: Number(id) }),
    select: employeeProfileSelect,
  });

  if (!employee) throw new Error("Employee not found");

  return employeeContractProfile(employee);
};

export const getEmployeeDocuments = async (id, tenantId) => {
  // BLOCKER-1 / C.2 — EmployeeMedia has no tenant column; deny cross-tenant doc
  // reads by construction by first asserting the parent employee is in-tenant.
  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id: Number(id) }),
    select: { id: true },
  });
  if (!employee) throw new Error("Employee not found");

  const documents = await prisma.employeeMedia.findMany({
    where: { employee_id: Number(id) },
    orderBy: { id: "desc" },
  });

  return {
    items: documents.map(employeeDocumentRow),
  };
};

export const updateEmployeeStatus = async (id, status, actorId) => {
  const parsed = employeeStatusSchema.parse({ status });

  const employee = await prisma.employee.update({
    where: { id: Number(id) },
    data: {
      status: parsed.status,
      employement_status: parsed.status,
      updatedById: actorId ? Number(actorId) : undefined,
    },
    select: compactEmployeeSelect,
  });

  return employeeDirectoryRow(employee);
};

export const uploadEmployeeProfilePhoto = async (id, payload, file, actorId) => {
  const data = mediaAttachSchema.parse(payload || {});
  file = file || fileFromBase64(data, "employee-profile-photo.bin");
  const media = await normalizeMediaPayload({
    mediaId: data.mediaId,
    file,
    type: "employee-profile-photo",
    fallback: data,
  });
  if (!media) throw new Error("mediaId or uploaded file is required");

  await prisma.employee.update({
    where: { id: Number(id) },
    data: {
      employee_media_id: media.mediaId,
      photo_url: media.url,
      updatedById: actorId ? Number(actorId) : undefined,
    },
  });

  return {
    mediaId: media.mediaId,
    url: media.url,
    fileName: media.fileName,
    mimeType: media.mimeType,
    size: media.fileSize,
    uploadedAt: new Date().toISOString(),
  };
};

export const uploadEmployeeCoverPhoto = async (id, payload, file, actorId) => {
  const data = mediaAttachSchema.parse(payload || {});
  file = file || fileFromBase64(data, "employee-cover-photo.bin");
  const media = await normalizeMediaPayload({
    mediaId: data.mediaId,
    file,
    type: "employee-cover-photo",
    fallback: data,
  });
  if (!media) throw new Error("mediaId or uploaded file is required");

  await prisma.employee.update({
    where: { id: Number(id) },
    data: {
      cover_photo_media_id: media.mediaId,
      cover_photo_url: media.url,
      updatedById: actorId ? Number(actorId) : undefined,
    },
  });

  return {
    mediaId: media.mediaId,
    url: media.url,
    fileName: media.fileName,
    mimeType: media.mimeType,
    size: media.fileSize,
    uploadedAt: new Date().toISOString(),
  };
};

export const createEmployeeDocument = async (employeeId, payload, file, actorId) => {
  await requireRecord("employee", employeeId, "Employee");
  const data = createEmployeeDocumentSchema.parse(payload || {});
  file = file || fileFromBase64(data, "employee-document.bin");
  if (!file && !data.mediaId) throw new Error("mediaId or uploaded file is required");
  const media = await normalizeMediaPayload({
    mediaId: data.mediaId,
    file,
    type: "employee-document",
    fallback: {
      fileName: data.fileName,
      mimeType: data.mimeType,
      fileSize: data.fileSize,
      url: data.downloadUrl,
    },
  });
  if (!media) throw new Error("mediaId or uploaded file is required");

  const document = await prisma.employeeMedia.create({
    data: documentDataFromContract(data, employeeId, actorId, media),
  });

  return employeeDocumentRow(document);
};

export const updateEmployeeDocument = async (employeeId, documentId, payload, file, actorId) => {
  const existing = await prisma.employeeMedia.findFirst({
    where: { id: Number(documentId), employee_id: Number(employeeId) },
  });
  if (!existing) throw new Error("Employee document not found");

  const data = updateEmployeeDocumentSchema.parse(payload || {});
  file = file || fileFromBase64(data, "employee-document.bin");
  const media = file || data.mediaId
    ? await normalizeMediaPayload({
        mediaId: data.mediaId || existing.media_id,
        file,
        type: "employee-document",
        fallback: {
          fileName: data.fileName || existing.file_name,
          mimeType: data.mimeType || existing.mime_type,
          fileSize: data.fileSize || existing.file_size,
          url: data.downloadUrl || existing.download_url,
        },
      })
    : null;

  const document = await prisma.employeeMedia.update({
    where: { id: Number(documentId) },
    data: {
      title: data.title ?? existing.title,
      category: data.category ?? existing.category,
      version: data.version ?? existing.version,
      visibility: data.visibility ?? existing.visibility,
      effective_date: data.effectiveDate ?? existing.effective_date,
      expiry_date: data.expiryDate ?? existing.expiry_date,
      notes: data.notes ?? existing.notes,
      media_id: media?.mediaId ?? data.mediaId ?? existing.media_id,
      file_name: media?.fileName ?? data.fileName ?? existing.file_name,
      mime_type: media?.mimeType ?? data.mimeType ?? existing.mime_type,
      file_size: media?.fileSize ?? data.fileSize ?? existing.file_size,
      download_url: media?.url ?? data.downloadUrl ?? existing.download_url,
      uploaded_by_id: actorId ? Number(actorId) : existing.uploaded_by_id,
      status: data.status ?? existing.status,
    },
  });

  return employeeDocumentRow(document);
};

export const deleteEmployeeDocument = async (employeeId, documentId) => {
  const existing = await prisma.employeeMedia.findFirst({
    where: { id: Number(documentId), employee_id: Number(employeeId) },
  });
  if (!existing) throw new Error("Employee document not found");
  await prisma.employeeMedia.delete({ where: { id: Number(documentId) } });
  return { id: Number(documentId), deleted: true };
};

export const listEmployeeEmergencyContacts = async (employeeId) => {
  await requireRecord("employee", employeeId, "Employee");
  const contacts = await prisma.emergencyContacts.findMany({
    where: { employee_Id: Number(employeeId) },
    orderBy: [{ is_primary: "desc" }, { id: "asc" }],
  });
  return { items: contacts.map(emergencyContactRow) };
};

export const createEmployeeEmergencyContact = async (employeeId, payload) => {
  await requireRecord("employee", employeeId, "Employee");
  const data = emergencyContactSchema.parse(payload);

  if (data.isPrimary) {
    await prisma.emergencyContacts.updateMany({
      where: { employee_Id: Number(employeeId), is_primary: true },
      data: { is_primary: false },
    });
  }

  const contact = await prisma.emergencyContacts.create({
    data: {
      Contact_name: data.contactName || data.name || null,
      relationship: data.relationship || null,
      phone: data.phone || null,
      email: data.email || null,
      is_primary: Boolean(data.isPrimary),
      employee_Id: Number(employeeId),
    },
  });

  return emergencyContactRow(contact);
};

export const updateEmployeeEmergencyContact = async (employeeId, contactId, payload) => {
  const existing = await prisma.emergencyContacts.findFirst({
    where: { id: Number(contactId), employee_Id: Number(employeeId) },
  });
  if (!existing) throw new Error("Emergency contact not found");

  const data = emergencyContactSchema.partial().parse(payload);

  if (data.isPrimary) {
    await prisma.emergencyContacts.updateMany({
      where: { employee_Id: Number(employeeId), is_primary: true, NOT: { id: Number(contactId) } },
      data: { is_primary: false },
    });
  }

  const contact = await prisma.emergencyContacts.update({
    where: { id: Number(contactId) },
    data: {
      Contact_name: data.contactName || data.name,
      relationship: data.relationship,
      phone: data.phone,
      email: data.email,
      is_primary: data.isPrimary,
    },
  });

  return emergencyContactRow(contact);
};

export const deleteEmployeeEmergencyContact = async (employeeId, contactId) => {
  const existing = await prisma.emergencyContacts.findFirst({
    where: { id: Number(contactId), employee_Id: Number(employeeId) },
  });
  if (!existing) throw new Error("Emergency contact not found");
  await prisma.emergencyContacts.delete({ where: { id: Number(contactId) } });
  return { id: Number(contactId), deleted: true };
};

export const listPositions = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const filters = {
    status: query.status || null,
    companyId: query.companyId ? String(query.companyId) : null,
    departmentId: query.departmentId ? String(query.departmentId) : null,
  };
  const where = {
    AND: [
      scopedWhere(tenantId, {}),
      list.q ? { title: { contains: list.q, mode: "insensitive" } } : {},
      filters.status ? { isActive: filters.status.toLowerCase() === "active" } : {},
    ],
  };

  const items = await prisma.position.findMany({
    where,
    include: { _count: { select: { employees: true, JobRequisition: true } } },
    orderBy: listOrder(list.sort, list.order, "createdAt", ["id", "title", "createdAt", "updatedAt"]),
  });

  const filteredItems = items
    .map(positionRow)
    .filter((position) => (filters.companyId ? String(position.companyId) === filters.companyId : true))
    .filter((position) => (filters.departmentId ? String(position.departmentId) === filters.departmentId : true));

  return buildListPayload({
    ...list,
    total: filteredItems.length,
    filters,
    items: filteredItems.slice(list.skip, list.skip + list.pageSize),
  });
};

export const getPosition = async (id, tenantId) => {
  // Tenant isolation: a position outside the caller's tenant is not found.
  const position = await prisma.position.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: {
      employees: { select: compactEmployeeSelect, take: 20, orderBy: { employee_name: "asc" } },
      JobRequisition: { take: 10, orderBy: { createdAt: "desc" } },
      _count: { select: { employees: true, JobRequisition: true } },
    },
  });

  if (!position) throw new Error("Position not found");

  return {
    ...positionRow(position),
    employees: position.employees.map(employeeDirectoryRow),
    requisitions: position.JobRequisition.map(requisitionRow),
  };
};

export const createPosition = async (data, actorId, tenantId) => {
  if (!data.title) throw new Error("Title is required");

  // C.2 / T-P2.6: scope the findFirst to the same tenant so the
  // generated job-code sequence doesn't cross tenant boundaries.
  const lastPosition = await prisma.position.findFirst({
    where: scopedWhere(tenantId, {}),
    orderBy: { id: "desc" },
    select: { id: true },
  });
  const nextId = lastPosition ? lastPosition.id + 1 : 1;

  const position = await prisma.position.create({
    // scopedData stamps tenantId (verified RBAC Company.uuid) onto every
    // new position row. If tenantId is null the column is written as null
    // (legacy / unscoped) — fail-closed: never writes another tenant's id.
    data: scopedData(tenantId, {
      title: data.title,
      description: buildPositionDescription(data),
      isActive: data.isActive ?? true,
      createdById: actorId ? Number(actorId) : null,
      jobCode: data.jobCode || `TST-${nextId.toString().padStart(3, "0")}`,
    }),
    include: { _count: { select: { employees: true, JobRequisition: true } } },
  });

  return positionRow(position);
};

export const updatePosition = async (id, data) => {
  const existing = await prisma.position.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Position not found");

  const position = await prisma.$transaction(async (tx) => {
    const updated = await tx.position.update({
      where: { id: Number(id) },
      data: {
        title: data.title,
        description: buildPositionDescription(data, existing.description),
        isActive: data.isActive,
        jobCode: data.jobCode,
      },
      include: { _count: { select: { employees: true, JobRequisition: true } } },
    });

    if (data.isActive !== undefined && Boolean(data.isActive) !== Boolean(existing.isActive)) {
      await tx.employee.updateMany({
        where: { positionId: Number(id) },
        data: {
          status: data.isActive ? "Active" : "Inactive",
          employement_status: data.isActive ? "Active" : "Inactive",
        },
      });
    }

    return updated;
  });

  return positionRow(position);
};

export const updatePositionStatus = async (id, isActive) => {
  const position = await prisma.$transaction(async (tx) => {
    const updated = await tx.position.update({
      where: { id: Number(id) },
      data: { isActive },
      include: { _count: { select: { employees: true, JobRequisition: true } } },
    });

    await tx.employee.updateMany({
      where: { positionId: Number(id) },
      data: {
        status: isActive ? "Active" : "Inactive",
        employement_status: isActive ? "Active" : "Inactive",
      },
    });

    return updated;
  });

  return positionRow(position);
};

export const listRequisitions = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const filters = {
    status: query.status || null,
    positionId: toInt(query.positionId),
  };
  const where = {
    AND: [
      scopedWhere(tenantId, {}),
      list.q ? { title: { contains: list.q, mode: "insensitive" } } : {},
      filters.status ? { status: filters.status } : {},
      filters.positionId ? { positionId: filters.positionId } : {},
    ],
  };

  const [items, total] = await Promise.all([
    prisma.jobRequisition.findMany({
      where,
      include: {
        position: true,
        requestedBy: true,
        approvedBy: true,
        approvals: { include: { approver: true }, orderBy: { id: "desc" } },
      },
      orderBy: listOrder(list.sort, list.order, "createdAt", ["id", "title", "createdAt", "updatedAt", "status"]),
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.jobRequisition.count({ where }),
  ]);

  return buildListPayload({ ...list, total, filters, items: items.map(requisitionRow) });
};

export const getRequisition = async (id, tenantId) => {
  // Tenant isolation: a requisition outside the caller's tenant is not found.
  const requisition = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      approvals: { include: { approver: true }, orderBy: { id: "desc" } },
      postings: { orderBy: { postedAt: "desc" } },
    },
  });

  if (!requisition) throw new Error("Requisition not found");

  return { ...requisitionRow(requisition), postings: requisition.postings };
};

export const createRequisition = async (data, actorId) => {
  if (!data.title) throw new Error("Title is required");
  if (!actorId) throw new Error("Employee context is required");

  const requisition = await prisma.jobRequisition.create({
    data: {
      title: data.title,
      description: data.description || null,
      departmentId: toInt(data.departmentId),
      positionId: toInt(data.positionId),
      // Hiring manager: an explicitly chosen requestedById wins, else the creator.
      requestedById: toInt(data.requestedById) || Number(actorId),
      openings: Number(data.openings || 1),
      status: data.status || "DRAFT",
    },
    include: { position: true, requestedBy: true, approvedBy: true, approvals: true },
  });

  return requisitionRow(requisition);
};

export const updateRequisition = async (id, data) => {
  const requisition = await prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: {
      title: data.title,
      description: data.description,
      departmentId: data.departmentId === undefined ? undefined : toInt(data.departmentId),
      positionId: data.positionId === undefined ? undefined : toInt(data.positionId),
      openings: data.openings === undefined ? undefined : Number(data.openings),
      requestedById:
        data.requestedById === undefined || data.requestedById === ''
          ? undefined
          : toInt(data.requestedById),
    },
    include: { position: true, requestedBy: true, approvedBy: true, approvals: true },
  });

  return requisitionRow(requisition);
};

const transitionRequisition = async ({ id, status, actorId, comments }) => {
  if (!actorId) throw new Error("Employee context is required");

  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
  if (!requisition) throw new Error("Requisition not found");

  const updated = await prisma.$transaction(async (tx) => {
    if (["APPROVED", "REJECTED"].includes(status)) {
      await tx.requisitionApproval.create({
        data: {
          requisitionId: Number(id),
          approverId: Number(actorId),
          status,
          comments,
          decidedAt: new Date(),
        },
      });
    }

    return tx.jobRequisition.update({
      where: { id: Number(id) },
      data: {
        status,
        approvedById: status === "APPROVED" || status === "REJECTED" ? Number(actorId) : undefined,
      },
      include: {
        position: true,
        requestedBy: true,
        approvedBy: true,
        approvals: { include: { approver: true }, orderBy: { id: "desc" } },
      },
    });
  });

  return requisitionRow(updated);
};

export const submitRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "PENDING_APPROVAL" });

export const approveRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "APPROVED" });

export const rejectRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "REJECTED" });

export const closeRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "CLOSED" });

export const reopenRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "DRAFT" });
