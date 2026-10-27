import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { resolveApprovalChain } from "./attendanceAnomalyRouting.service.js";
import { uploadFileToDAM, getDamAssetById } from "./dam.media.service.js";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const history = (row) =>
  Array.isArray(row.workflowHistory) ? row.workflowHistory : [];
const attached = (row) =>
  Array.isArray(row.attachments) ? row.attachments : [];
export const isManagementLevel = (step) =>
  /management|mgmt/i.test(step?.role || "");
export async function assertAnomalyPeriodEditable(tx, row, tenantId) {
  if (!row.date) fail(400, "The anomaly must have an affected shift date");
  const run = await tx.payrollRun.findFirst({
    where: {
      tenantId,
      periodStart: { lte: row.date },
      periodEnd: { gte: row.date },
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    select: { id: true },
  });
  if (run)
    fail(
      409,
      "Recall/cancel the submitted payroll period before changing attendance decisions",
    );
}
export async function uploadAnomalyAttachments(files = []) {
  if (!Array.isArray(files) || files.length > 5)
    fail(400, "Attach at most 5 files");
  const validated = files.map((file) => {
    if (
      !file ||
      typeof file.fileBase64 !== "string" ||
      file.fileBase64.length > 2800000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.fileBase64)
    )
      fail(400, "Invalid attachment content");
    const buffer = Buffer.from(file.fileBase64, "base64");
    if (!buffer.length || buffer.length > 2 * 1024 * 1024)
      fail(400, "Each attachment must be at most 2 MB");
    const pdf = buffer.subarray(0, 5).toString() === "%PDF-";
    const png = buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const mime = pdf
      ? "application/pdf"
      : png
        ? "image/png"
        : jpeg
          ? "image/jpeg"
          : null;
    if (!mime || mime !== file.mimeType)
      fail(
        400,
        "Attachments must be PDF, PNG or JPEG files matching their content",
      );
    const name = String(file.fileName || "attachment")
      .replace(/[\\/\u0000-\u001f]/g, "_")
      .slice(0, 200);
    return { buffer, mimetype: mime, originalname: name };
  });
  if (validated.reduce((n, f) => n + f.buffer.length, 0) > 5 * 1024 * 1024)
    fail(400, "Attachments must total at most 5 MB");
  const result = [];
  for (const file of validated) {
    const uploaded = await uploadFileToDAM(file, "document");
    const item = uploaded?.[0];
    if (!item?.id)
      fail(502, "Attachment upload failed; the request was not submitted");
    result.push({
      mediaId: item.id,
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.buffer.length,
    });
  }
  return result;
}
async function load(tenantId, anomalyId) {
  const row = await prisma.attendanceAnomaly.findFirst({
    where: { tenantId, id: anomalyId },
  });
  if (!row) fail(404, "Anomaly not found");
  return row;
}
async function save(row, tenantId, version, data, event, extra) {
  if (row.workflowVersion !== version)
    fail(409, "Request changed; refresh before trying again");
  return tenantTransaction(
    prisma,
    async (tx) => {
      await assertAnomalyPeriodEditable(tx, row, tenantId);
      const updated = await tx.attendanceAnomaly.updateMany({
        where: { tenantId, id: row.id, workflowVersion: version },
        data: {
          ...data,
          workflowVersion: { increment: 1 },
          workflowHistory: [...history(row), JSON.parse(JSON.stringify(event))],
        },
      });
      if (updated.count !== 1)
        fail(409, "Request changed; refresh before trying again");
      if (extra) await extra(tx);
      return tx.attendanceAnomaly.findFirst({
        where: { tenantId, id: row.id },
      });
    },
    { tenantId, txOptions: { isolationLevel: "Serializable" } },
  );
}
export async function markAnomalyDeduction({
  tenantId,
  anomalyId,
  actorEmployeeId,
  actorUserId,
  isAdmin = false,
  days,
  comment,
  version,
}) {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
}
export async function returnAnomalyRequest({
  tenantId,
  anomalyId,
  actorEmployeeId,
  targetLevel,
  comment,
  version,
}) {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
}
export async function resubmitAnomalyRequest({
  tenantId,
  anomalyId,
  actorEmployeeId,
  reason,
  attachments = [],
  version,
}) {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
}
export async function anomalyAttachmentUrl({
  tenantId,
  anomalyId,
  actorEmployeeId,
  isAdmin = false,
  mediaId,
}) {
  const row = await load(tenantId, anomalyId);
  const chain = await resolveApprovalChain({
    tenantId,
    employeeId: row.employeeId,
    approvalPolicy: row.approvalPolicy,
  });
  if (
    !isAdmin &&
    actorEmployeeId !== row.employeeId &&
    !chain.some((s) => s.resolved && s.approverId === actorEmployeeId)
  )
    fail(403, "You are not a participant in this request");
  if (!attached(row).some((a) => String(a.mediaId) === String(mediaId)))
    fail(404, "Attachment not found on this request");
  const asset = await getDamAssetById(mediaId);
  const url = asset?.download_url || asset?.url || asset?.file_url;
  if (typeof url !== "string" || !url.startsWith("https://"))
    fail(502, "Attachment is unavailable; try again later");
  return { url };
}
