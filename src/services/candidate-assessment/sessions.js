import { attemptPolicy } from "./attempt-policy.js";
import {
  beginSections,
  activeSection,
  sectionView,
  reconcileSections,
  nextSection,
  adjustSection,
  hasSectionClocks,
} from "./section-clocks.js";
import { withPeriodExposure, reserveExposure } from "./exposure.js";
import { itemImageReference } from "./images.js";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { decryptString } from "../../lib/crypto.js";
import {
  run,
  load,
  interview,
  version,
  event,
  fail,
  json,
  has,
} from "./base.js";
import { assemble, scoreTest, scoreItem } from "./rules.js";
import { resolveBlueprint } from "./catalog.js";
const reception = "hr.recruitment.reception";
async function adminAudit(tx, env, action, detail) {
  await tx.log.create({
    data: {
      tenantId: env.tenantId,
      employeeId: env.who.id,
      actionById: env.who.id,
      type: action,
      action_type: action,
      module: "Recruitment kiosk administration",
      result: "SUCCESS",
      ip: env.ctx.ip ?? "unknown",
      os: "server",
      notes: JSON.stringify(detail),
      correlationId: env.ctx.correlationId ?? null,
    },
  });
}

const sitesWhere = (env) =>
  has(env, "hr.recruitment.assessment.admin")
    ? {}
    : { siteRef: { in: env.who.recruitmentSiteRefs ?? [] } };
const assertStation = (env, station) => {
  if (
    !has(env, "hr.recruitment.assessment.admin") &&
    !(env.who.recruitmentSiteRefs ?? []).includes(station.siteRef)
  )
    fail("Workstation not found", 404);
};
const receptionStatus = (s) =>
  [
    "PASSED",
    "BORDERLINE",
    "FAILED",
    "REVIEW",
    "INCOMPLETE",
    "RELEASED",
    "OVERRIDDEN",
    "WAIVED",
  ].includes(s)
    ? "COMPLETED_REFER_TO_RECRUITER"
    : s;
export const receptionWorkstations = () =>
  run(reception, async (tx, env) => ({
    items: await tx.testWorkstation.findMany({
      where: {
        tenantId: env.tenantId,
        ...sitesWhere(env),
        status: "ACTIVE",
        tokenExpiresAt: { gt: env.now },
      },
      select: { id: true, label: true, siteRef: true, lastSeenAt: true },
      orderBy: { label: "asc" },
    }),
  }));
export const receptionStaffList = (input = {}) =>
  run("hr.recruitment.assessment.admin", async (tx, env) => {
    const limit = Math.min(100, Math.max(1, input.limit ?? 30));
    const q = String(input.q ?? "").trim();
    const rows = await tx.employee.findMany({
      where: {
        tenant_id: env.tenantId,
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        ...(q
          ? {
              OR: [
                { first_name: { contains: q, mode: "insensitive" } },
                { last_name: { contains: q, mode: "insensitive" } },
                { employee_code: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        employee_code: true,
        recruitmentSiteRefs: true,
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map((row) => ({
        employeeId: row.id,
        name: [row.first_name, row.last_name].filter(Boolean).join(" "),
        employeeCode: row.employee_code,
        siteRefs: row.recruitmentSiteRefs ?? [],
      })),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  });
export const receptionSitesAssign = (input) =>
  run("hr.recruitment.assessment.admin", async (tx, env) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM "Employee" WHERE tenant_id=$1::uuid AND id=$2 FOR UPDATE',
      env.tenantId,
      input.employeeId,
    );
    const employee = await tx.employee.findFirst({
      where: { id: input.employeeId, tenant_id: env.tenantId },
      select: { id: true, recruitmentSiteRefs: true },
    });
    if (!employee) fail("Employee not found", 404);
    const sites = [...new Set(input.siteRefs.map((site) => site.trim()))];
    if (sites.some((site) => !site || site.length > 100) || sites.length > 50)
      fail("Use valid recruitment site references");
    if (
      input.expectedSiteRefs &&
      JSON.stringify([...employee.recruitmentSiteRefs].sort()) !==
        JSON.stringify([...input.expectedSiteRefs].sort())
    )
      fail(
        "Reception assignments changed; refresh before saving",
        412,
        "HR-6005",
      );
    const known = await tx.testWorkstation.findMany({
      where: { tenantId: env.tenantId, siteRef: { in: sites } },
      select: { siteRef: true },
    });
    if (sites.some((site) => !known.some((row) => row.siteRef === site)))
      fail("Register a company workstation at each selected site first");
    await tx.employee.update({
      where: { id: employee.id },
      data: { recruitmentSiteRefs: sites },
    });
    await adminAudit(tx, env, "ASSIGN", {
      employeeId: employee.id,
      previousSiteRefs: employee.recruitmentSiteRefs,
      siteRefs: sites,
    });
    return { employeeId: employee.id, siteRefs: sites };
  });

export const tokenHash = (v) => createHash("sha256").update(v).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const publicSession = (s, now = new Date(), section = null) => ({
  section: sectionView(s, section, now),
  id: s.id,
  status: s.status,
  startedAt: s.startedAt,
  deadlineAt: s.deadlineAt,
  serverTime: now,
  remainingSeconds: s.deadlineAt
    ? Math.max(
        0,
        Math.floor(
          (new Date(s.deadlineAt) -
            (s.status === "PAUSED" && s.pausedAt ? s.pausedAt : now)) /
            1000,
        ),
      )
    : null,
  itemCount: s.itemOrder.length,
  currentIndex: s.currentIndex,
  revision: s.revision,
  language: s.blueprintSnapshot.language,
  navigation: s.blueprintSnapshot.navigation,
});
export const workstationRegister = (input) =>
  run("hr.recruitment.assessment.admin", async (tx, env) => {
    if (!input.label?.trim() || !input.siteRef?.trim())
      fail("Workstation label and site are required");
    const raw = env.tenantId + "." + token(),
      data = {
        tenantId: env.tenantId,
        label: input.label.trim(),
        siteRef: input.siteRef.trim(),
        deviceTokenHash: tokenHash(raw),
        registeredById: env.who.id,
        tokenExpiresAt: new Date(+env.now + 30 * 86400000),
        status: "ACTIVE",
      };
    if (input.id) {
      await load(tx, env, "testWorkstation", input.id, { lock: true });
      const row = await tx.testWorkstation.update({
        where: { id: input.id },
        data,
      });
      await adminAudit(tx, env, "ROTATE", {
        workstationId: row.id,
        siteRef: data.siteRef,
      });
      return { id: row.id, token: raw, expiresAt: row.tokenExpiresAt };
    }
    const row = await tx.testWorkstation.create({ data });
    await adminAudit(tx, env, "REGISTER", {
      workstationId: row.id,
      siteRef: data.siteRef,
    });
    return { id: row.id, token: raw, expiresAt: row.tokenExpiresAt };
  });
export const workstationsList = () =>
  run("hr.recruitment.assessment.admin", async (tx, env) => ({
    items: await tx.testWorkstation.findMany({
      where: { tenantId: env.tenantId },
      select: {
        id: true,
        label: true,
        siteRef: true,
        status: true,
        lastSeenAt: true,
        tokenExpiresAt: true,
      },
      orderBy: { id: "asc" },
    }),
  }));
export const workstationRevoke = (input) =>
  run("hr.recruitment.assessment.admin", async (tx, env) => {
    await load(tx, env, "testWorkstation", input.id, { lock: true });
    await tx.testWorkstation.update({
      where: { id: input.id },
      data: { status: "REVOKED" },
    });
    await adminAudit(tx, env, "REVOKE", { workstationId: input.id });
    return { id: input.id, status: "REVOKED" };
  });
export const arrivalsList = (input) =>
  run(reception, async (tx, env) => {
    if (
      Date.parse(input.to) - Date.parse(input.from) > 48 * 3600000 ||
      Date.parse(input.from) < +env.now - 48 * 3600000 ||
      Date.parse(input.to) > +env.now + 72 * 3600000
    )
      fail("Reception can view current arrivals only", 422);
    const rows = await tx.interview.findMany({
      where: {
        tenantId: env.tenantId,
        ...sitesWhere(env),
        scheduledAt: { gte: new Date(input.from), lt: new Date(input.to) },
        status: "SCHEDULED",
      },
      select: {
        id: true,
        scheduledAt: true,
        siteRef: true,
        location: true,
        assessmentStatus: true,
        application: {
          select: {
            id: true,
            candidate: {
              select: { id: true, firstName: true, lastName: true },
            },
            jobRequisition: { select: { title: true } },
          },
        },
      },
      orderBy: { scheduledAt: "asc" },
      take: 200,
    });
    return {
      items: rows.map((row) => ({
        ...row,
        assessmentStatus: receptionStatus(row.assessmentStatus),
      })),
    };
  });
export const checkIn = (input) =>
  run(reception, async (tx, env) => {
    const i = await interview(tx, env, input.interviewId, {
      reception: true,
      lock: true,
    });
    if (i.status !== "SCHEDULED")
      fail("Only a scheduled interview can be checked in");
    if (!input.consent) fail("Assessment consent is required");
    if (input.photoMediaId && !input.photoConsent)
      fail("Photo consent must be explicit");
    const existing = await tx.candidateCheckIn.findFirst({
      where: { tenantId: env.tenantId, interviewId: i.id },
    });
    if (existing)
      return {
        id: existing.id,
        interviewId: i.id,
        arrivedAt: existing.arrivedAt,
      };
    const row = await tx.candidateCheckIn.create({
      data: {
        tenantId: env.tenantId,
        interviewId: i.id,
        candidateId: i.application.candidateId,
        idType: input.idType,
        idLast4: input.idLast4,
        verifiedById: env.who.id,
        consentAt: env.now,
        photoMediaId: input.photoMediaId ?? null,
        photoConsentAt: input.photoConsent ? env.now : null,
        accommodationReason: input.accommodationReason ?? null,
      },
    });
    if (i.assessmentStatus === "REQUIRED")
      await tx.interview.update({
        where: { id: i.id },
        data: { assessmentStatus: "CHECKED_IN" },
      });
    await event(tx, env, "candidate_checked_in", {
      applicationId: i.applicationId,
      interviewId: i.id,
      candidateId: i.application.candidateId,
    });
    return { id: row.id, interviewId: i.id, arrivedAt: row.arrivedAt };
  });
async function integrity(tx, env, s, type, detail = {}) {
  await tx.candidateTestIntegrityEvent.create({
    data: {
      tenantId: env.tenantId,
      sessionId: s.id,
      type,
      detail: json(detail),
    },
  });
  await event(tx, env, "test_integrity_flagged", {
    applicationId: s.applicationId,
    interviewId: s.interviewId,
    sessionId: s.id,
  });
}
export const sessionIssue = (input) =>
  run(reception, async (tx, env) => {
    const i = await interview(tx, env, input.interviewId, {
      reception: true,
      lock: true,
    });
    if (
      i.status !== "SCHEDULED" ||
      ![
        "REQUIRED",
        "CHECKED_IN",
        "IN_PROGRESS",
        "INCOMPLETE",
        "FAILED",
        "REVIEW",
      ].includes(i.assessmentStatus)
    )
      fail("Interview is not waiting for a test");
    if (
      !(await tx.candidateCheckIn.findFirst({
        where: { tenantId: env.tenantId, interviewId: i.id },
      }))
    )
      fail("Check in and record consent first");
    const station = await load(
      tx,
      env,
      "testWorkstation",
      input.workstationId,
      { lock: true },
    );
    assertStation(env, station);
    if (i.siteRef && i.siteRef !== station.siteRef)
      fail("The interview and workstation must be at the same site");
    if (station.status !== "ACTIVE" || station.tokenExpiresAt <= env.now)
      fail("Register an active workstation");
    let s = await tx.candidateTestSession.findFirst({
      where: {
        tenantId: env.tenantId,
        interviewId: i.id,
        status: { in: ["ISSUED", "IN_PROGRESS", "PAUSED"] },
      },
      orderBy: { id: "desc" },
    });
    if (s) {
      s = await load(tx, env, "candidateTestSession", s.id, { lock: true });
      if (!input.reason?.trim())
        fail("A reason is required to reissue a session");
      if (s.deadlineAt && s.deadlineAt <= env.now && s.status !== "PAUSED")
        fail("The test deadline has passed");
      if (s.workstationId !== station.id)
        await integrity(tx, env, s, "DEVICE_CHANGE", {
          from: s.workstationId,
          to: station.id,
          reason: input.reason,
        });
    }
    const occupied = await tx.candidateTestSession.findFirst({
      where: {
        tenantId: env.tenantId,
        workstationId: station.id,
        status: { in: ["ISSUED", "IN_PROGRESS", "PAUSED"] },
        ...(s ? { id: { not: s.id } } : {}),
      },
      select: { id: true },
    });
    if (occupied)
      fail(
        "This workstation already has an active session; select a free PC",
        409,
      );
    const bp =
      s?.blueprintSnapshot ??
      (await resolveBlueprint(tx, env.tenantId, i.application.jobRequisition));
    if (!bp) fail("No published blueprint resolves for this interview");
    if (!s) {
      // Serialize issuance across this candidate's interviews and workstations.
      await tx.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
        env.tenantId,
        i.application.candidateId,
      );
      const active = await tx.candidateTestSession.findFirst({
        where: {
          tenantId: env.tenantId,
          candidateId: i.application.candidateId,
          status: { in: ["ISSUED", "IN_PROGRESS", "PAUSED"] },
        },
      });
      if (active)
        fail(
          "This candidate already has an active assessment; resume or resolve it first",
          409,
          "HR-6006",
        );
      const prior = await tx.candidateTestSession.findFirst({
        where: {
          tenantId: env.tenantId,
          candidateId: i.application.candidateId,
          blueprintSnapshot: { path: ["jobFamily"], equals: bp.jobFamily },
        },
        orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      });
      const result = prior
        ? await tx.candidateTestResult.findUnique({
            where: { sessionId: prior.id },
          })
        : null;
      const policy = attemptPolicy(prior, result, bp, env.now);
      if (policy.kind === "REUSE") {
        await tx.interview.update({
          where: { id: i.id },
          data: {
            assessmentRequired: true,
            assessmentStatus: policy.band,
            assessmentResultId: policy.resultId,
          },
        });
        await adminAudit(tx, env, "REUSE", {
          interviewId: i.id,
          sourceSessionId: prior.id,
          resultId: policy.resultId,
        });
        await event(tx, env, "test_result_decided", {
          applicationId: i.applicationId,
          interviewId: i.id,
          resultId: policy.resultId,
        });
        return {
          reusedResultId: policy.resultId,
          assessmentStatus: "COMPLETED_REFER_TO_RECRUITER",
        };
      }
      if (policy.kind === "COOLDOWN")
        fail(
          "The retake cooldown has not elapsed; eligible from " +
            policy.eligibleAt.toISOString().slice(0, 10),
          409,
          "HR-6006",
        );
      if (
        policy.kind === "REISSUE" &&
        (!env.scope.unrestricted || !input.reason?.trim())
      )
        fail(
          "A recruiter must record a reason to reissue an incomplete assessment",
          409,
          "HR-6006",
        );
      if (["REISSUE", "RETEST"].includes(policy.kind))
        await adminAudit(tx, env, policy.kind, {
          interviewId: i.id,
          sourceSessionId: prior.id,
          resultId: result?.id ?? null,
          reason: input.reason ?? result?.decisionReason,
        });
    }
    const extra = input.extraTimePct ?? s?.extraTimePct ?? 0;
    if (!Number.isFinite(extra) || extra < 0 || extra > 50)
      fail("Extra time must be between 0 and 50 percent");
    if (s && extra !== s.extraTimePct)
      fail(
        "Reissuing preserves the existing accommodation; use the extend action to change it",
      );
    if (!s && extra > 0 && !env.scope.unrestricted)
      fail("A recruiter must authorize additional test time", 403);
    if (extra > 0 && !input.reason?.trim())
      fail("Accommodation requires a reason");
    let code, hash;
    do {
      code = String(randomInt(100000, 1000000));
      hash = tokenHash(station.id + ":" + code);
    } while (
      await tx.candidateTestSession.findFirst({
        where: {
          tenantId: env.tenantId,
          workstationId: station.id,
          sessionCodeHash: hash,
          codeExpiresAt: { gt: env.now },
        },
      })
    );
    const common = {
      workstationId: station.id,
      sessionCodeHash: hash,
      accessTokenHash: null,
      codeExpiresAt: new Date(+env.now + 15 * 60000),
    };
    if (s)
      s = await tx.candidateTestSession.update({
        where: { id: s.id },
        data: { ...common, revision: { increment: 1 } },
      });
    else
      s = await tx.candidateTestSession.create({
        data: {
          ...common,
          tenantId: env.tenantId,
          applicationId: i.applicationId,
          candidateId: i.application.candidateId,
          interviewId: i.id,
          blueprintId: bp.id,
          blueprintVersion: bp.version,
          blueprintSnapshot: json(bp),
          extraTimePct: extra,
          itemOrder: [],
          issuedById: env.who.id,
        },
      });
    await tx.interview.update({
      where: { id: i.id },
      data: {
        assessmentRequired: true,
        assessmentStatus: s.startedAt ? "IN_PROGRESS" : "CHECKED_IN",
      },
    });
    await event(tx, env, "test_session_issued", {
      applicationId: s.applicationId,
      interviewId: i.id,
      sessionId: s.id,
    });
    return {
      sessionId: s.id,
      code,
      expiresAt: s.codeExpiresAt,
      remainingSeconds: publicSession(s, env.now).remainingSeconds,
    };
  });
export const sessionsLive = () =>
  run(reception, async (tx, env) => {
    const allowedStations = await tx.testWorkstation.findMany({
      where: { tenantId: env.tenantId, ...sitesWhere(env) },
      select: { id: true },
    });
    const rows = await tx.candidateTestSession.findMany({
      where: {
        tenantId: env.tenantId,
        workstationId: { in: allowedStations.map((w) => w.id) },
        status: { in: ["ISSUED", "IN_PROGRESS", "PAUSED"] },
      },
      orderBy: { issuedAt: "asc" },
      take: 200,
    });
    const items = [];
    for (const s of rows)
      items.push({
        ...publicSession(s, env.now),
        interviewId: s.interviewId,
        workstationId: s.workstationId,
        answered: await tx.candidateTestResponse.count({
          where: { tenantId: env.tenantId, sessionId: s.id },
        }),
        integrityFlags: await tx.candidateTestIntegrityEvent.count({
          where: { tenantId: env.tenantId, sessionId: s.id },
        }),
      });
    return { items };
  });
export const sessionControl = (action, input) =>
  run(reception, async (tx, env) => {
    const s = await load(tx, env, "candidateTestSession", input.id, {
      lock: true,
    });
    assertStation(env, await load(tx, env, "testWorkstation", s.workstationId));
    version(s, input.expectedVersion);
    if (!["IN_PROGRESS", "PAUSED", "ISSUED"].includes(s.status))
      fail("The session has ended");
    const clock = await clockState(tx, env, s);
    if (clock.ended) return publicSession(s, env.now);
    let data = { revision: { increment: 1 } };
    if (action === "PAUSE") {
      if (s.status !== "IN_PROGRESS" || s.deadlineAt <= env.now)
        fail("Only an active test can be paused");
      data = { ...data, status: "PAUSED", pausedAt: env.now };
      await integrity(tx, env, s, "PROCTOR_PAUSE", { reason: input.reason });
    } else if (action === "RESUME") {
      if (s.status !== "PAUSED") fail("The session is not paused");
      data = {
        ...data,
        status: "IN_PROGRESS",
        pausedAt: null,
        deadlineAt: new Date(+s.deadlineAt + (env.now - s.pausedAt)),
      };
    } else if (action === "EXTEND") {
      if (!env.scope.unrestricted)
        fail("A recruiter must authorize additional test time", 403);
      if (!Number.isFinite(input.extraTimePct) || input.extraTimePct <= 0)
        fail("Additional time must be a positive percentage");
      if (
        !s.deadlineAt ||
        (s.status === "IN_PROGRESS" && s.deadlineAt <= env.now)
      )
        fail("The session deadline has passed");
      const extra = s.extraTimePct + input.extraTimePct;
      if (extra > 50) fail("Total extra time cannot exceed 50 percent");
      data = {
        ...data,
        extraTimePct: extra,
        deadlineAt: new Date(
          +s.deadlineAt +
            (s.blueprintSnapshot.durationMin * 60000 * input.extraTimePct) /
              100,
        ),
      };
      await integrity(tx, env, s, "PROCTOR_EXTEND", {
        reason: input.reason,
        extraTimePct: input.extraTimePct,
      });
    } else if (action === "VOID") {
      await integrity(tx, env, s, "PROCTOR_VOID", { reason: input.reason });
      return finish(tx, env, s, "VOIDED");
    } else fail("Unknown session action");
    const updated = await tx.candidateTestSession.update({
      where: { id: s.id },
      data,
    });
    const section = await adjustSection(tx, env, updated, action, s, input);
    return publicSession(updated, env.now, section);
  });
export async function finish(tx, env, s, status = "SUBMITTED") {
  const prior = await tx.candidateTestResult.findUnique({
    where: { sessionId: s.id },
  });
  if (prior) return prior;
  if (hasSectionClocks(s))
    await tx.$executeRawUnsafe(
      'UPDATE "CandidateTestSessionSection" SET "closedAt"=$3 WHERE "tenantId"=$1::uuid AND "sessionId"=$2 AND "closedAt" IS NULL',
      env.tenantId,
      s.id,
      env.now,
    );
  const refs = s.itemOrder,
    items = await tx.candidateTestItem.findMany({
      where: { tenantId: env.tenantId, id: { in: refs.map((r) => r.itemId) } },
    }),
    responses = await tx.candidateTestResponse.findMany({
      where: { tenantId: env.tenantId, sessionId: s.id },
    }),
    flags = await tx.candidateTestIntegrityEvent.count({
      where: {
        tenantId: env.tenantId,
        sessionId: s.id,
        type: {
          in: [
            "FOCUS_LOST",
            "FULLSCREEN_EXIT",
            "RAPID_ANSWER",
            "DEVICE_CHANGE",
          ],
        },
      },
    });
  const keys = Object.fromEntries(
      items.map((i) => [i.id, JSON.parse(decryptString(i.answerKey))]),
    ),
    scored = scoreTest(
      s.blueprintSnapshot,
      refs,
      items,
      responses,
      keys,
      flags,
      status !== "SUBMITTED",
    );
  const result = await tx.candidateTestResult.create({
    data: {
      tenantId: env.tenantId,
      sessionId: s.id,
      applicationId: s.applicationId,
      interviewId: s.interviewId,
      ...scored,
    },
  });
  await tx.candidateTestSession.update({
    where: { id: s.id },
    data: {
      status,
      submittedAt: env.now,
      sessionCodeHash: null,
      revision: { increment: 1 },
    },
  });
  await tx.interview.update({
    where: { id: s.interviewId },
    data: { assessmentStatus: result.band, assessmentResultId: result.id },
  });
  await event(tx, env, "test_session_submitted", {
    applicationId: s.applicationId,
    interviewId: s.interviewId,
    sessionId: s.id,
  });
  await event(tx, env, "test_result_recorded", {
    applicationId: s.applicationId,
    interviewId: s.interviewId,
    sessionId: s.id,
    resultId: result.id,
  });
  return result;
}
export async function kioskStart(tx, env, station, input) {
  let s = await tx.candidateTestSession.findFirst({
    where: {
      tenantId: env.tenantId,
      workstationId: station.id,
      sessionCodeHash: tokenHash(station.id + ":" + input.code),
      codeExpiresAt: { gt: env.now },
      status: { in: ["ISSUED", "IN_PROGRESS", "PAUSED"] },
    },
  });
  if (!s || !input.consent) fail("Session code is unavailable", 401, "HR-6007");
  s = await load(tx, env, "candidateTestSession", s.id, { lock: true });
  if (
    s.sessionCodeHash !== tokenHash(station.id + ":" + input.code) ||
    s.workstationId !== station.id ||
    s.codeExpiresAt <= env.now ||
    !["ISSUED", "IN_PROGRESS", "PAUSED"].includes(s.status)
  )
    fail("Session code is unavailable", 401, "HR-6007");
  if (s.status === "PAUSED") fail("Ask reception to resume the test", 409);
  if (s.deadlineAt && s.deadlineAt <= env.now)
    fail("The test deadline has passed", 409);
  const firstStart = !s.startedAt;
  let data = {};
  if (firstStart) {
    const previous = await tx.candidateTestSession.findMany({
      where: {
        tenantId: env.tenantId,
        candidateId: s.candidateId,
        id: { not: s.id },
      },
      select: { itemOrder: true },
    });
    const seen = previous.flatMap((p) => p.itemOrder.map((r) => r.itemCode));
    const items = await tx.candidateTestItem.findMany({
      where: {
        tenantId: env.tenantId,
        status: "PUBLISHED",
        jobFamily: s.blueprintSnapshot.jobFamily,
        language: s.blueprintSnapshot.language,
      },
    });
    const periodItems = await withPeriodExposure(tx, env, items);
    const order = assemble(s.blueprintSnapshot, periodItems, seen);
    for (const ref of order)
      await reserveExposure(
        tx,
        env,
        items.find((i) => i.id === ref.itemId),
      );
    data = {
      itemOrder: order,
      startedAt: env.now,
      itemStartedAt: env.now,
      deadlineAt: new Date(
        +env.now +
          s.blueprintSnapshot.durationMin * 60000 * (1 + s.extraTimePct / 100),
      ),
    };
  }
  const accessToken = token();
  s = await tx.candidateTestSession.update({
    where: { id: s.id },
    data: {
      ...data,
      status: "IN_PROGRESS",
      accessTokenHash: tokenHash(accessToken),
      sessionCodeHash: null,
      lastHeartbeatAt: env.now,
      revision: { increment: 1 },
    },
  });
  await tx.interview.update({
    where: { id: s.interviewId },
    data: { assessmentStatus: "IN_PROGRESS" },
  });
  await event(tx, env, "test_session_started", {
    applicationId: s.applicationId,
    interviewId: s.interviewId,
    sessionId: s.id,
  });
  if (firstStart) await beginSections(tx, env, s);
  const clock = await clockState(tx, env, s);
  return { ...publicSession(s, env.now, clock.row), accessToken };
}
export async function kioskSession(tx, env, station, id, accessToken) {
  const s = await load(tx, env, "candidateTestSession", id, { lock: true });
  if (
    s.workstationId !== station.id ||
    !accessToken ||
    s.accessTokenHash !== tokenHash(accessToken)
  )
    fail("Session unavailable", 401, "HR-6007");
  return s;
}
async function clockState(tx, env, s) {
  if (s.status !== "IN_PROGRESS")
    return {
      row: ["ISSUED", "PAUSED"].includes(s.status)
        ? await activeSection(tx, env, s)
        : null,
      changed: false,
      ended: false,
    };
  let state;
  if (s.deadlineAt <= env.now)
    state = { row: null, changed: false, ended: true };
  else state = await reconcileSections(tx, env, s);
  if (state.ended) {
    await finish(tx, env, s, "EXPIRED");
    s.status = "EXPIRED";
    s.revision++;
  }
  return state;
}
export async function kioskOperate(tx, env, s, operation, input = {}) {
  const clock = await clockState(tx, env, s);
  if (operation === "STATE") return publicSession(s, env.now, clock.row);
  if (clock.ended) return { expired: true, ...publicSession(s, env.now) };
  if (["SUBMITTED", "EXPIRED", "VOIDED"].includes(s.status)) {
    if (operation === "SUBMIT") return { received: true };
    fail("The session has ended", 409);
  }
  if (s.status !== "IN_PROGRESS") fail("The session is paused", 409);
  // Return state instead of throwing: the clock transition must commit even if
  // a stale answer or navigation request arrived at the section deadline.
  const changed = () => ({
    sectionChanged: true,
    ...publicSession(s, env.now, clock.row),
  });
  if (
    clock.changed &&
    !["HEARTBEAT", "INTEGRITY", "SUBMIT"].includes(operation)
  )
    return changed();
  if (operation === "NEXT_SECTION") {
    if (!clock.row || input.sectionKey !== clock.row.sectionKey)
      return changed();
    if (input.confirmed !== true)
      fail("Confirm that you are ready to leave this section");
    if (clock.row.sectionIndex + 1 >= s.blueprintSnapshot.sections.length)
      fail("This is the last section; submit the assessment instead");
    const row = await nextSection(tx, env, s, clock.row);
    return publicSession(s, env.now, row);
  }
  if (operation === "SUBMIT") {
    await finish(tx, env, s);
    return { received: true };
  }
  if (operation === "HEARTBEAT") {
    await tx.candidateTestSession.update({
      where: { id: s.id },
      data: { lastHeartbeatAt: env.now },
    });
    return publicSession(s, env.now, clock.row);
  }
  if (operation === "INTEGRITY") {
    await integrity(tx, env, s, input.type, {});
    return { received: true };
  }
  const index = ["ITEM", "IMAGE"].includes(operation)
    ? input.index
    : s.itemOrder.findIndex((r) => r.itemId === input.itemId);
  if (index < 0 || index >= s.itemOrder.length) fail("Item unavailable", 404);
  if (clock.row && s.itemOrder[index].sectionKey !== clock.row.sectionKey)
    return changed();
  if (
    s.blueprintSnapshot.navigation === "FORWARD_ONLY" &&
    (index < s.currentIndex || index > s.currentIndex + 1)
  )
    fail("Move forward one item at a time", 409);
  const ref = s.itemOrder[index],
    item = await tx.candidateTestItem.findFirst({
      where: {
        tenantId: env.tenantId,
        id: ref.itemId,
        version: ref.itemVersion,
      },
    });
  if (!item) fail("Item unavailable", 404);
  if (operation === "IMAGE") {
    if (!item.mediaId) fail("Image unavailable", 404);
    return itemImageReference(tx, env.tenantId, item.id);
  }
  if (operation === "ITEM") {
    if (index !== s.currentIndex)
      await tx.candidateTestSession.update({
        where: { id: s.id },
        data: { currentIndex: index, itemStartedAt: env.now },
      });
    const saved = await tx.candidateTestResponse.findUnique({
      where: { sessionId_itemId: { sessionId: s.id, itemId: item.id } },
    });
    return {
      itemId: item.id,
      index,
      type: item.type,
      stem: item.stem,
      mediaId: item.mediaId,
      options: ref.optionOrder.map((k) =>
        item.options.find((o) => o.key === k),
      ),
      answer: saved?.answer ?? null,
      serverTime: env.now,
      deadlineAt: s.deadlineAt,
    };
  }
  scoreItem(item, JSON.parse(decryptString(item.answerKey)), input.answer, 0);
  const existing = await tx.candidateTestResponse.findUnique({
    where: { sessionId_itemId: { sessionId: s.id, itemId: item.id } },
  });
  const time = Math.max(0, (env.now - (s.itemStartedAt ?? s.startedAt)) / 1000);
  if (!existing && time < 2)
    await integrity(tx, env, s, "RAPID_ANSWER", { itemId: item.id });
  await tx.candidateTestResponse.upsert({
    where: { sessionId_itemId: { sessionId: s.id, itemId: item.id } },
    create: {
      tenantId: env.tenantId,
      sessionId: s.id,
      itemId: item.id,
      itemVersion: item.version,
      answer: input.answer,
      answeredAt: env.now,
      timeSpentSec: time,
    },
    update: {
      answer: input.answer,
      answeredAt: env.now,
      timeSpentSec: Math.max(time, existing?.timeSpentSec ?? 0),
    },
  });
  return { saved: true, answeredAt: env.now };
}
