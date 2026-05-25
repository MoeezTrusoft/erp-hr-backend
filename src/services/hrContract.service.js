import prisma from "../config/prisma.js";
import { getDamAssetById, normalizeDamAssetResponse, uploadFileToDAM } from "./dam.media.service.js";
import { logAction } from "../utils/logs.js";
import { buildListPayload, parseListQuery, toInt } from "../utils/apiContract.js";
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
  Position: { select: { id: true, title: true, jobCode: true, isActive: true } },
  manager: { select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true } },
  businessUnit: { select: { id: true, name: true } },
  gradeLevel: { select: { id: true, name: true } },
  region: { select: { id: true, name: true } },
};

const employeeDirectoryRow = (employee) => ({
  id: employee.id,
  code: employee.employee_code,
  name: employeeName(employee),
  email: employee.work_email || employee.email,
  phone: employee.work_phone || employee.personal_contact,
  role: employee.job_title || employee.Position?.title,
  position: employee.Position
    ? { id: employee.Position.id, title: employee.Position.title, code: employee.Position.jobCode }
    : null,
  department: employee.businessUnit?.name || null,
  grade: employee.gradeLevel?.name || null,
  location: employee.region?.name || null,
  manager: employee.manager
    ? { id: employee.manager.id, name: employeeName(employee.manager), role: employee.manager.job_title }
    : null,
  status: employee.status || employee.employement_status || "Active",
  avatarUrl: employee.photo_url,
  hireDate: employee.hire_date || employee.joining_date,
  updatedAt: employee.updated_at,
});

const positionRow = (position) => ({
  id: position.id,
  title: position.title,
  description: position.description,
  code: position.jobCode,
  status: position.isActive ? "Active" : "Inactive",
  isActive: position.isActive,
  filledCount: position._count?.employees || 0,
  openCount: Math.max((position._count?.JobRequisition || 0) - (position._count?.employees || 0), 0),
  requisitionCount: position._count?.JobRequisition || 0,
  createdAt: position.createdAt,
  updatedAt: position.updatedAt,
});

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

const assertEmployeeReferences = async (data, currentEmployeeId = null) => {
  await requireRecord("position", data.positionId, "Position");
  await requireRecord("businessUnit", data.departmentId, "Department");
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
    businessUnitId: data.departmentId,
    managerId: data.managerId,
    regionId: data.locationId,
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

  if (data.hireDate) update.tenureMonths = calculateTenureMonths(data.hireDate);
  if (actorId && !existing.id) update.createdById = Number(actorId);

  const firstName = data.firstName ?? existing.first_name;
  const middleName = data.middleName ?? existing.middle_name;
  const lastName = data.lastName ?? existing.last_name;
  const name = [firstName, middleName, lastName].filter(Boolean).join(" ");
  if (name) update.employee_name = name;

  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
};

const employeeProfileSelect = {
  ...compactEmployeeSelect,
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

const employeeContractProfile = (employee) => ({
  summary: employeeDirectoryRow(employee),
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
    departmentId: employee.businessUnitId,
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
  emergencyContacts: employee.emergencyContact?.map(emergencyContactRow) || [],
  documents: employee.employee_media?.map(employeeDocumentRow) || [],
  org: {
    manager: employee.manager
      ? { id: employee.manager.id, name: employeeName(employee.manager), role: employee.manager.job_title }
      : null,
    reports: employee.reports?.map((report) => ({ id: report.id, name: employeeName(report), role: report.job_title })),
    teamMembers: employee.teamMembers?.map((member) => ({ id: member.id, name: employeeName(member), role: member.job_title })),
  },
});

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
      url: mediaUrl(asset, fallback.url),
      fileName: mediaFileName(asset, null, fallback.fileName),
      mimeType: asset?.mime_type || fallback.mimeType || null,
      fileSize: Number(asset?.file_size || asset?.size || fallback.fileSize || 0) || null,
      asset,
    };
  }

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

export const listEmployees = async (query) => {
  const list = parseListQuery(query, { sort: "created_at" });
  const filters = {
    status: query.status || null,
    positionId: toInt(query.positionId),
    departmentId: toInt(query.departmentId),
  };

  const where = {
    AND: [
      list.q
        ? {
            OR: [
              { employee_name: { contains: list.q, mode: "insensitive" } },
              { first_name: { contains: list.q, mode: "insensitive" } },
              { last_name: { contains: list.q, mode: "insensitive" } },
              { employee_code: { contains: list.q, mode: "insensitive" } },
              { email: { contains: list.q, mode: "insensitive" } },
              { work_email: { contains: list.q, mode: "insensitive" } },
              { job_title: { contains: list.q, mode: "insensitive" } },
            ],
          }
        : {},
      filters.status
        ? { OR: [{ status: filters.status }, { employement_status: filters.status }] }
        : {},
      filters.positionId ? { positionId: filters.positionId } : {},
      filters.departmentId ? { businessUnitId: filters.departmentId } : {},
    ],
  };

  const allowedSorts = ["created_at", "updated_at", "employee_name", "employee_code", "hire_date"];
  const orderBy = { [allowedSorts.includes(list.sort) ? list.sort : "created_at"]: list.order };

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

export const getEmployeeQuickView = async (id) => {
  const employee = await prisma.employee.findUnique({
    where: { id: Number(id) },
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

export const createEmployee = async (payload, actorId) => {
  const data = createEmployeeContractSchema.parse(normalizeContractPayload(payload));
  await assertEmployeeReferences(data);
  const profilePhoto = data.profilePhotoMediaId
    ? await normalizeMediaPayload({ mediaId: data.profilePhotoMediaId, type: "employee-profile-photo" })
    : null;
  const coverPhoto = data.coverPhotoMediaId
    ? await normalizeMediaPayload({ mediaId: data.coverPhotoMediaId, type: "employee-cover-photo" })
    : null;
  const employeeData = {
    ...data,
    profilePhotoUrl: profilePhoto?.url,
    coverPhotoUrl: coverPhoto?.url,
  };

  const employee = await prisma.$transaction(async (tx) => {
    const created = await tx.employee.create({
      data: employeeDataFromContract(employeeData, actorId),
      select: { id: true },
    });

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

    if (data.documents.length > 0) {
      await tx.employeeMedia.createMany({
        data: data.documents.map((document) => {
          const parsedDocument = createEmployeeDocumentSchema.parse(document);
          if (!parsedDocument.mediaId) {
            throw new Error("Nested employee documents require mediaId");
          }
          return documentDataFromContract(parsedDocument, created.id, actorId);
        }),
      });
    }

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

  return employeeContractProfile(employee);
};

export const updateEmployee = async (id, payload, actorId) => {
  const employeeId = Number(id);
  const existing = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!existing) throw new Error("Employee not found");

  const data = updateEmployeeContractSchema.parse(normalizeContractPayload(payload));
  await assertEmployeeReferences(data, employeeId);
  const profilePhoto = data.profilePhotoMediaId
    ? await normalizeMediaPayload({ mediaId: data.profilePhotoMediaId, type: "employee-profile-photo" })
    : null;
  const coverPhoto = data.coverPhotoMediaId
    ? await normalizeMediaPayload({ mediaId: data.coverPhotoMediaId, type: "employee-cover-photo" })
    : null;
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

export const getEmployeeProfile = async (id) => {
  const employee = await prisma.employee.findUnique({
    where: { id: Number(id) },
    select: employeeProfileSelect,
  });

  if (!employee) throw new Error("Employee not found");

  return employeeContractProfile(employee);
};

export const getEmployeeDocuments = async (id) => {
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

export const listPositions = async (query) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const filters = { status: query.status || null };
  const where = {
    AND: [
      list.q ? { title: { contains: list.q, mode: "insensitive" } } : {},
      filters.status ? { isActive: filters.status.toLowerCase() === "active" } : {},
    ],
  };

  const [items, total] = await Promise.all([
    prisma.position.findMany({
      where,
      include: { _count: { select: { employees: true, JobRequisition: true } } },
      orderBy: listOrder(list.sort, list.order, "createdAt", ["id", "title", "createdAt", "updatedAt"]),
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.position.count({ where }),
  ]);

  return buildListPayload({ ...list, total, filters, items: items.map(positionRow) });
};

export const getPosition = async (id) => {
  const position = await prisma.position.findUnique({
    where: { id: Number(id) },
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

export const createPosition = async (data, actorId) => {
  if (!data.title) throw new Error("Title is required");

  const lastPosition = await prisma.position.findFirst({
    orderBy: { id: "desc" },
    select: { id: true },
  });
  const nextId = lastPosition ? lastPosition.id + 1 : 1;

  const position = await prisma.position.create({
    data: {
      title: data.title,
      description: data.description || null,
      isActive: data.isActive ?? true,
      createdById: actorId ? Number(actorId) : null,
      jobCode: data.jobCode || `TST-${nextId.toString().padStart(3, "0")}`,
    },
    include: { _count: { select: { employees: true, JobRequisition: true } } },
  });

  return positionRow(position);
};

export const updatePosition = async (id, data) => {
  const position = await prisma.position.update({
    where: { id: Number(id) },
    data: {
      title: data.title,
      description: data.description,
      isActive: data.isActive,
      jobCode: data.jobCode,
    },
    include: { _count: { select: { employees: true, JobRequisition: true } } },
  });

  return positionRow(position);
};

export const updatePositionStatus = async (id, isActive) => {
  const position = await prisma.position.update({
    where: { id: Number(id) },
    data: { isActive },
    include: { _count: { select: { employees: true, JobRequisition: true } } },
  });

  return positionRow(position);
};

export const listRequisitions = async (query) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const filters = {
    status: query.status || null,
    positionId: toInt(query.positionId),
  };
  const where = {
    AND: [
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

export const getRequisition = async (id) => {
  const requisition = await prisma.jobRequisition.findUnique({
    where: { id: Number(id) },
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
      requestedById: Number(actorId),
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
