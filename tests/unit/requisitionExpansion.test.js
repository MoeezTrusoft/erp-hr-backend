// tests/unit/requisitionExpansion.test.js
//
// Phase 2.2 — requisition expansion: the mandatory-field SUBMISSION GATE, the
// expansion field vocabulary, structured job content, and the attachment ACL.
//
// Why these are one suite: the whole point of the phase is that the same rule is
// enforced on every surface. Testing the gate in isolation would pass even if the
// services never called it, so the last block drives the real submit/update entry
// points and asserts the gate actually fires there.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { approvalCentreDouble } from "./helpers/approval-centre-double.js";

import {
  EMPLOYMENT_TYPES,
  FIELD_LOCKED_KEYS,
  HIRING_REASONS,
  assertRequisitionFieldsEditable,
  assertRequisitionSubmittable,
  assertReplacementPairing,
  missingSubmissionFields,
  normalizeJobContent,
  normalizeVocabulary,
  pickRequisitionFields,
} from "../../src/lib/requisitionFields.js";
import {
  RECRUITMENT_SCOPE,
  attachmentAudience,
  requisitionAttachmentScopeWhere,
} from "../../src/lib/recruitmentAccess.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

// A requisition that satisfies every mandatory rule.
const COMPLETE = {
  id: 5,
  title: "Backend Engineer",
  departmentId: 3,
  location: "Karachi",
  employmentType: "FULL_TIME",
  openings: 2,
  requestedById: 7,
  hiringReason: "NEW_HIRE",
  costCenterRef: "CC-100",
};

describe("Phase 2.2 — mandatory-field submission gate", () => {
  it("passes a requisition that carries every mandatory field", () => {
    expect(missingSubmissionFields(COMPLETE)).toEqual([]);
    expect(() => assertRequisitionSubmittable(COMPLETE)).not.toThrow();
  });

  it("reports EVERY missing field at once rather than the first", () => {
    const missing = missingSubmissionFields({ id: 5, title: "Backend Engineer" }).map((m) => m.field);

    // All seven remaining mandatory fields, not just one — a recruiter must be able
    // to fix the form in a single pass.
    expect(missing).toEqual([
      "departmentId",
      "location",
      "employmentType",
      "openings",
      "requestedById",
      "hiringReason",
      "costCenterRef",
    ]);
  });

  it("treats an empty string as unset, so a blank field cannot satisfy the gate", () => {
    expect(missingSubmissionFields({ ...COMPLETE, location: "" }).map((m) => m.field)).toEqual(["location"]);
    expect(missingSubmissionFields({ ...COMPLETE, location: null }).map((m) => m.field)).toEqual(["location"]);
  });

  it("requires a named replacement employee only when the hiring reason is REPLACEMENT", () => {
    expect(missingSubmissionFields({ ...COMPLETE, hiringReason: "REPLACEMENT" }).map((m) => m.field)).toEqual([
      "replacementEmployeeId",
    ]);
    expect(
      missingSubmissionFields({ ...COMPLETE, hiringReason: "REPLACEMENT", replacementEmployeeId: 12 }),
    ).toEqual([]);
    // A non-replacement reason does not need one.
    expect(missingSubmissionFields({ ...COMPLETE, hiringReason: "NEW_HIRE" })).toEqual([]);
  });

  it("throws 422 carrying the machine-readable field list", () => {
    let caught;
    try {
      assertRequisitionSubmittable({ id: 5 });
    } catch (error) {
      caught = error;
    }
    expect(caught.status).toBe(422);
    expect(caught.code).toBe("HR-RECRUITMENT-REQUISITION-INCOMPLETE");
    expect(caught.details.missingFields).toContain("costCenterRef");
  });

  it("never grandfathers: a draft that was legal yesterday is not submittable today", () => {
    // The pre-Phase-2.2 shape of a real requisition — title, department, openings.
    const legacyDraft = { id: 99, title: "Old Role", departmentId: 1, openings: 1, requestedById: 4 };
    expect(() => assertRequisitionSubmittable(legacyDraft)).toThrow(/cannot be submitted/i);
    // …but it stays READABLE — the gate is a submission rule, not a read rule.
    // It is missing exactly the fields Phase 2.2 introduced: location, employment
    // type, hiring reason and the cost-center reference.
    expect(missingSubmissionFields(legacyDraft).map((m) => m.field)).toEqual([
      "location",
      "employmentType",
      "hiringReason",
      "costCenterRef",
    ]);
  });
});

describe("FR-02.02 — the post-submission field lock", () => {
  it("allows field edits on a DRAFT and on a status-less legacy row", () => {
    expect(() => assertRequisitionFieldsEditable({ status: "DRAFT" }, { title: "New" })).not.toThrow();
    expect(() => assertRequisitionFieldsEditable({}, { title: "New" })).not.toThrow();
  });

  it("refuses field edits once the requisition left DRAFT, naming the fields", () => {
    for (const status of ["PENDING_APPROVAL", "APPROVED", "POSTED", "CLOSED"]) {
      try {
        assertRequisitionFieldsEditable({ status }, { openings: 3 });
        expect.unreachable(`${status} should have refused`);
      } catch (e) {
        expect(e.status).toBe(409);
        expect(e.code).toBe("HR-RECRUITMENT-REQUISITION-LOCKED");
        expect(e.fields).toEqual(["openings"]);
      }
    }
  });

  it("passes a status-only payload through — transitions are not field edits", () => {
    expect(() =>
      assertRequisitionFieldsEditable({ status: "PENDING_APPROVAL" }, { status: "PENDING_APPROVAL", comments: "resubmit" }),
    ).not.toThrow();
  });

  it("ignores transport keys (expectedVersion) and absent-field partial PATCHes", () => {
    expect(() =>
      assertRequisitionFieldsEditable({ status: "APPROVED" }, { expectedVersion: 4 }),
    ).not.toThrow();
    expect(() => assertRequisitionFieldsEditable({ status: "APPROVED" }, {})).not.toThrow();
  });

  it("locks every field the two write surfaces can change", () => {
    // Every expansion key plus the core keys must be covered — a new field that
    // forgets to join the list would be editable on a POSTED requisition.
    const expansionKeys = Object.keys(pickRequisitionFields({
      location: "x", employmentType: "FULL_TIME", targetStartDate: "2026-01-01",
      gradeLevelId: 1, costCenterRef: "x", costCenterLabel: "x", budgetRef: "x",
      budgetLabel: "x", hiringReason: "NEW_HIRE", replacementEmployeeId: 1,
      recruiterId: 1, closesAt: "2026-12-01", autoCloseWhenFilled: true,
      jobContent: { summary: "s" },
    }));
    for (const key of expansionKeys) expect(FIELD_LOCKED_KEYS).toContain(key);
    for (const key of ["title", "description", "departmentId", "positionId", "openings", "priority"]) {
      expect(FIELD_LOCKED_KEYS).toContain(key);
    }
  });

  it("is wired into BOTH field-editing services", async () => {
    const requisitionSrc = await import("fs").then((fs) =>
      fs.promises.readFile("src/services/requisition.service.js", "utf8"));
    const legacySrc = await import("fs").then((fs) =>
      fs.promises.readFile("src/services/hrContract.service.js", "utf8"));
    expect(requisitionSrc).toContain("assertRequisitionFieldsEditable");
    expect(legacySrc).toContain("assertRequisitionFieldsEditable");
  });
});

describe("Phase 2.2 — expansion field normalization", () => {
  it("normalizes the closed vocabularies and rejects an unknown value", () => {
    expect(normalizeVocabulary("full_time", EMPLOYMENT_TYPES, "employmentType")).toBe("FULL_TIME");
    expect(normalizeVocabulary("replacement", HIRING_REASONS, "hiringReason")).toBe("REPLACEMENT");
    expect(normalizeVocabulary(undefined, EMPLOYMENT_TYPES, "employmentType")).toBeNull();
    expect(() => normalizeVocabulary("PERMANENT", EMPLOYMENT_TYPES, "employmentType")).toThrow(/must be one of/);
  });

  it("only writes keys the payload actually carried, so a partial PATCH cannot wipe fields", () => {
    expect(pickRequisitionFields({ location: "Lahore" })).toEqual({ location: "Lahore" });
    // An explicit null DOES clear — the difference between "absent" and "cleared"
    // is the whole reason the distinction exists.
    expect(pickRequisitionFields({ location: null })).toEqual({ location: null });
    expect(pickRequisitionFields({})).toEqual({});
  });

  it("rejects a non-numeric id rather than writing NaN", () => {
    expect(() => pickRequisitionFields({ recruiterId: "abc" })).toThrow(/positive integer id/);
    expect(() => pickRequisitionFields({ gradeLevelId: 0 })).toThrow(/positive integer id/);
  });

  it("validates the replacement pairing against the MERGED row", () => {
    // Setting only the reason is legal when the row already names a replacement.
    expect(() => assertReplacementPairing({ hiringReason: "REPLACEMENT", replacementEmployeeId: 12 })).not.toThrow();
    expect(() => assertReplacementPairing({ hiringReason: "REPLACEMENT" })).toThrow(/replacementEmployeeId is required/);
    // Reclassifying away from REPLACEMENT needs no replacement employee.
    expect(() => assertReplacementPairing({ hiringReason: "NEW_HIRE" })).not.toThrow();
  });
});

describe("Phase 2.2 — structured job content", () => {
  it("stamps the schema version and keeps the sections it was given", () => {
    const content = normalizeJobContent({
      summary: "  Own the payments service  ",
      responsibilities: ["Design APIs", "  ", "Review code"],
      faq: [{ question: "Remote?", answer: "Hybrid" }],
    });

    expect(content.schemaVersion).toBe(1);
    expect(content.summary).toBe("Own the payments service");
    expect(content.responsibilities).toEqual(["Design APIs", "Review code"]); // blanks dropped
    expect(content.faq).toEqual([{ question: "Remote?", answer: "Hybrid" }]);
  });

  it("accepts a JSON string from MCP and refuses a malformed one", () => {
    expect(normalizeJobContent('{"summary":"Hi"}').summary).toBe("Hi");
    expect(() => normalizeJobContent("{not json")).toThrow(/valid JSON string/);
  });

  it("refuses a shape the candidate portal could not render", () => {
    expect(() => normalizeJobContent({ responsibilities: "Design APIs" })).toThrow(/must be an array/);
    expect(() => normalizeJobContent({ faq: ["Remote?"] })).toThrow(/question, answer/);
    expect(normalizeJobContent(null)).toBeNull();
  });
});

describe("Phase 2.2 — requisition attachment visibility", () => {
  it("gives only an ORG caller the internal documents", () => {
    expect(attachmentAudience(RECRUITMENT_SCOPE.ORG)).toBe("INTERNAL");
    for (const scope of [
      RECRUITMENT_SCOPE.MANAGED,
      RECRUITMENT_SCOPE.ASSIGNED,
      RECRUITMENT_SCOPE.FINANCE,
      RECRUITMENT_SCOPE.AGENCY,
    ]) {
      expect(attachmentAudience(scope)).toBe("HIRING_TEAM");
    }
  });

  it("fails closed for an unrecognised scope", () => {
    // A scope value nobody anticipated must get the NARROW arm, not the wide one.
    expect(attachmentAudience("SOMETHING_NEW")).toBe("HIRING_TEAM");
    expect(requisitionAttachmentScopeWhere("SOMETHING_NEW")).toEqual({ visibility: "HIRING_TEAM" });
  });

  it("filters the read predicate by audience, and gives an agency nothing", () => {
    expect(requisitionAttachmentScopeWhere(RECRUITMENT_SCOPE.ORG)).toEqual({});
    expect(requisitionAttachmentScopeWhere(RECRUITMENT_SCOPE.ASSIGNED)).toEqual({ visibility: "HIRING_TEAM" });
    expect(requisitionAttachmentScopeWhere(RECRUITMENT_SCOPE.AGENCY)).toEqual({ id: { in: [] } });
  });
});

// ── The gate at the real entry points ───────────────────────────────────────
//
// The blocks above prove the rule; this proves the services CALL it. Without
// this, a refactor could drop the guard argument and every test above would still
// pass while requisitions flowed into approval with no cost center.
const prisma = {
  jobRequisition: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  requisitionApproval: { create: jest.fn(), findMany: jest.fn(async () => []) },
  requisitionApprovalRule: { findMany: jest.fn(async () => []) },
  requisitionTransition: { create: jest.fn() },
  jobPosting: { create: jest.fn() },
  businessUnit: { findMany: jest.fn() },
  // Phase 4 — the submit path also consults the hiring freeze. This suite is
  // about the FIELD gate, so no freeze is ever in effect here.
  recruitmentHiringFreeze: { findFirst: jest.fn(async () => null) },
  employee: { findFirst: jest.fn(async () => ({ managerId: 9 })) },
};

// The HR Approval Centre owns the PENDING_APPROVAL move once the gate passes,
// and (Phase 7) writes the transition row and the submitted event in the same
// transaction: the double runs the REAL onSubmit (approval/adapters.js) on
// `prisma`, so a gate that ran too late would leave those rows behind.
const centre = approvalCentreDouble(prisma);
jest.unstable_mockModule("../../src/services/approval/legacy.js", () => ({
  legacyDecision: jest.fn(async () => {
    throw Object.assign(new Error("HR-4201"), { status: 409, code: "HR-4201" });
  }),
  legacySubmit: centre.legacySubmit,
}));

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  getDepartmentById: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((client, fn) => fn(client)),
  rlsTenantExtension: jest.fn((client) => client),
}));

const { submitRequisition } = await import("../../src/services/requisitionMgmt.service.js");
const { updateRequisition } = await import("../../src/services/requisition.service.js");

beforeEach(() => {
  jest.clearAllMocks();
  centre.reset();
  prisma.requisitionTransition.create.mockResolvedValue({ id: 1 });
  prisma.jobRequisition.updateMany.mockResolvedValue({ count: 1 });
  prisma.jobRequisition.update.mockResolvedValue({ id: 5, status: "PENDING_APPROVAL" });
  prisma.businessUnit.findMany.mockResolvedValue([]);
  prisma.jobRequisition.findMany.mockResolvedValue([]);
});

describe("Phase 2.2 — the gate is wired into the real submit paths", () => {
  it("refuses to submit an incomplete requisition and writes nothing", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 5, title: "Backend Engineer", status: "DRAFT" });
    // Armed, so a gate that ran AFTER the centre would leave its rows behind.
    centre.arm({ tenantId: TENANT, actorId: 9, row: { id: 5, title: "Backend Engineer", status: "DRAFT" } });

    await expect(submitRequisition(5, TENANT, 9)).rejects.toThrow(/cannot be submitted/i);
    expect(centre.legacySubmit).not.toHaveBeenCalled();
    // A refused submit must leave no status flip and no history row.
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
  });

  it("submits once the same requisition is complete", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ ...COMPLETE, status: "DRAFT" });
    centre.arm({ tenantId: TENANT, actorId: 9, row: { ...COMPLETE, status: "DRAFT" } });

    await submitRequisition(5, TENANT, 9);

    // The gate passed, so the HR Approval Centre opened the review, and its
    // submit transaction recorded the move for this surface.
    expect(centre.legacySubmit).toHaveBeenCalledTimes(1);
    expect(centre.legacySubmit).toHaveBeenCalledWith("REQUISITION", 5, undefined, {
      requisition: { reason: null, transitionSource: "requisition.submit" },
    });
    expect(prisma.requisitionTransition.create).toHaveBeenCalledTimes(1);
    expect(prisma.requisitionTransition.create.mock.calls[0][0].data).toMatchObject({
      fromStatus: "DRAFT",
      toStatus: "PENDING_APPROVAL",
      actorId: 9,
      source: "requisition.submit",
    });
  });

  it("validates the requisition AS IT WILL BE, so fixing the fields and submitting in one PATCH works", async () => {
    // The row on disk is still incomplete; this update supplies everything missing.
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce({ id: 5, title: "Backend Engineer", status: "DRAFT" })
      .mockResolvedValueOnce({ ...COMPLETE, status: "PENDING_APPROVAL" });
    // The centre loads the row as the PATCH left it: complete, still DRAFT.
    centre.arm({ tenantId: TENANT, actorId: 9, row: { ...COMPLETE, status: "DRAFT" } });

    await updateRequisition(
      5,
      {
        location: "Karachi",
        departmentId: 3,
        employmentType: "FULL_TIME",
        openings: 2,
        requestedById: 7,
        hiringReason: "NEW_HIRE",
        costCenterRef: "CC-100",
        status: "PENDING_APPROVAL",
      },
      9,
      TENANT,
    );

    expect(prisma.jobRequisition.updateMany).toHaveBeenCalled();
    expect(centre.legacySubmit).toHaveBeenCalledTimes(1);
    expect(centre.legacySubmit).toHaveBeenCalledWith("REQUISITION", 5, undefined, {
      requisition: { reason: null, transitionSource: "requisition.update" },
    });
  });

  it("still refuses a bare status flip on an incomplete requisition", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({ id: 5, title: "Backend Engineer", status: "DRAFT" });

    centre.arm({ tenantId: TENANT, actorId: 9, row: { id: 5, title: "Backend Engineer", status: "DRAFT" } });

    await expect(updateRequisition(5, { status: "PENDING_APPROVAL" }, 9, TENANT)).rejects.toThrow(
      /cannot be submitted/i,
    );
    expect(prisma.jobRequisition.updateMany).not.toHaveBeenCalled();
    expect(centre.legacySubmit).not.toHaveBeenCalled();
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
  });
});
