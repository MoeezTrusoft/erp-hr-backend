import { z } from "zod";
import { registerAttendanceEvaluationTools } from './attendanceEvaluationTools.js';
import { registerAttendanceRulesTools } from './attendanceRulesTools.js';
import { mcpCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  captureOverview,
  listCaptureEvents,
  captureTrace,
  reviewCaptureEvents,
  registerCaptureDevice,
  updateCaptureDevice,
} from "../../services/attendanceCapture.service.js";
import { reEnrol } from "../../services/deviceEnrolment.service.js";
import { getAttendanceImport } from "../../services/attendanceImport.service.js";
import {
  configureBiometricDevice,
  requestBiometricEnrolment,
  listBiometricProfiles,
  revokeBiometricProfile,
} from "../../services/attendanceBiometric.service.js";
import {
  biometricModality,
  biometricSlot,
} from "../../lib/attendanceBiometric.js";
import {
  emitAttendanceCaptureChanged,
  emitAttendanceDeviceChanged,
} from "../../services/hrConfigEvents.js";

// R15 — capture was poll-only on the frontend because no fabric event existed
// for a review or a device change. These emitters are fail-soft (the write has
// already committed); `event` names the family the frontend subscribes to.
const publishCaptureEvent = async (event, { name, args, data, tenantId, actorId }) => {
  if (event === "device") {
    await emitAttendanceDeviceChanged({
      tenantId,
      actorId,
      deviceId: args?.id ?? data?.device?.id ?? args?.sn,
      action: name.replace("hr_attendance_", ""),
    });
    return;
  }
  await emitAttendanceCaptureChanged({
    tenantId,
    actorId,
    captureId: args?.id ?? args?.items?.[0]?.id ?? data?.batchId,
    action: name.replace("hr_attendance_", ""),
  });
};

export function registerAttendanceCaptureTools(server) {
  registerAttendanceEvaluationTools(server);
  registerAttendanceRulesTools(server);
  const tool = (name, description, schema, method, fn, event) =>
    server.tool(
      name,
      description,
      schema,
      withToolError(async (args) => {
        const { user, permissions } = mcpCtx.getStore() || {};
        if (!user?.tenantId)
          throw Object.assign(new Error("Authentication required"), {
            status: 401,
          });
        // This is an HR operations surface; a VIEW-only employee cannot enumerate
        // other employees' raw identity evidence or device credentials.
        assertPermission(permissions, method, "hr:attendance", user.isAdmin);
        const data = await fn({
          ...args,
          tenantId: user.tenantId,
          actorId: user.id || user.userId || user.employeeId,
        });
        if (event) {
          await publishCaptureEvent(event, {
            name,
            args,
            data,
            tenantId: user.tenantId,
            actorId: user.id || user.userId || user.employeeId,
          });
        }
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }, name),
    );
  tool(
    "hr_attendance_capture_overview",
    "Device freshness, capture queue counts and processing latency",
    {},
    "PUT",
    captureOverview,
  );
  tool(
    "hr_attendance_capture_list",
    "Page attendance evidence and processing exceptions",
    {
      state: z
        .enum(["PENDING", "PROCESSED", "NEEDS_REVIEW", "FAILED", "DISMISSED"])
        .optional(),
      afterId: z.string().uuid().optional(),
      employeeId: z.number().int().positive().optional(),
      sn: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    "PUT",
    listCaptureEvents,
  );
  tool(
    "hr_attendance_capture_trace",
    "Original evidence, attribution, calculation results and review audit",
    { id: z.string().uuid() },
    "PUT",
    captureTrace,
  );
  tool(
    "hr_attendance_capture_review",
    "Resolve dated enrolment, retry processing or dismiss selected evidence with a reason",
    {
      items: z
        .array(
          z.object({
            id: z.string().uuid(),
            version: z.number().int().positive(),
            employeeId: z.number().int().positive().optional(),
          }),
        )
        .min(1)
        .max(100),
      action: z.enum(["RESOLVE", "RETRY", "DISMISS", "APPROVE_BIOMETRIC"]),
      reason: z.string().trim().min(1).max(2000),
    },
    "PUT",
    reviewCaptureEvents,
    "capture",
  );
  tool(
    "hr_attendance_device_register",
    "Register a device and return its credential once",
    {
      sn: z.string().min(1).max(64),
      name: z.string().min(1).max(120),
      timeZone: z.string().min(1),
      staleAfterMinutes: z.number().int().min(1).max(10080).optional(),
    },
    "PUT",
    registerCaptureDevice,
    "device",
  );
  tool(
    "hr_attendance_device_update",
    "Activate, suspend or rotate a device credential",
    {
      id: z.string().uuid(),
      active: z.boolean().optional(),
      rotateCredential: z.boolean().optional(),
      reason: z.string().trim().min(1).max(2000),
    },
    "PUT",
    updateCaptureDevice,
    "device",
  );
  tool(
    "hr_attendance_device_enrol",
    "Create a dated device enrolment with overlap protection and an audit reason",
    {
      employeeId: z.number().int().positive(),
      newDeviceUserId: z.string().min(1).max(64),
      sn: z.string().min(1).max(64),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      note: z.string().trim().min(1).max(2000),
      isPrimary: z.boolean().optional(),
    },
    "PUT",
    reEnrol,
    "device",
  );
  tool(
    "hr_attendance_import_status",
    "Resume an import batch and download its validation report",
    { batchId: z.string().uuid() },
    "POST",
    getAttendanceImport,
  );
  tool(
    "hr_attendance_biometric_device_configure",
    "Bind a kiosk signing key and site; record validation of its fingerprint PAD configuration",
    {
      id: z.string().uuid(),
      publicKey: z.string().max(2048),
      site: z.string().trim().min(1).max(120),
      fingerprintPadLevel: z.number().int().min(0).max(100),
      fingerprintPadValidated: z.boolean(),
      reason: z.string().trim().min(1).max(2000),
    },
    "PUT",
    configureBiometricDevice,
    "device",
  );
  tool(
    "hr_attendance_biometric_enrol_request",
    "Authorize a supervised biometric enrolment at a registered kiosk; returns a short-lived capture ticket",
    {
      deviceId: z.string().uuid(),
      employeeId: z.number().int().positive(),
      modality: biometricModality,
      slot: biometricSlot,
      reason: z.string().trim().min(1).max(2000),
    },
    "PUT",
    requestBiometricEnrolment,
    "capture",
  );
  tool(
    "hr_attendance_biometric_profiles",
    "List biometric enrolment metadata without exposing templates or images",
    {
      employeeId: z.number().int().positive(),
    },
    "PUT",
    listBiometricProfiles,
  );
  tool(
    "hr_attendance_biometric_revoke",
    "Revoke a biometric enrolment and erase its encrypted template while retaining the audit record",
    {
      id: z.string().uuid(),
      reason: z.string().trim().min(1).max(2000),
    },
    "PUT",
    revokeBiometricProfile,
    "capture",
  );
}
