import * as C from "@trusoft/contracts/performance-appraisals";
import {
  run,
  fail,
  has,
  expected,
  person,
  review,
  audit,
  digest,
  json,
} from "./base.js";

async function roundRow(tx, e, id, { open = false, lock = false } = {}) {
  if (lock)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${e.tenantId + ":peer-round:" + id},0))`;
  const round = await tx.perfPeerRound.findFirst({
    where: { tenantId: e.tenantId, id },
  });
  if (!round) fail("NOT_FOUND", "Peer feedback round not found", 404);
  if (open && (round.state !== "OPEN" || +round.closesAt <= +e.now))
    fail("PEER_WINDOW_CLOSED", "The peer response window is closed", 409);
  return round;
}
function managerScope(e, scope) {
  if (scope.self || (!scope.manager && !has(e, "hr.performance.read.all")))
    fail("FORBIDDEN", "Current evaluator or HR authority required", 403);
}
export const peerRoundCreate = (raw) => {
  const i = C.PeerRoundCreate.parse(raw);
  return run(
    "peer.round.create",
    i,
    "hr.performance.peer.manage",
    async (tx, e) => {
      const scope = await review(tx, e, i.reviewId, { write: true });
      managerScope(e, scope);
      if (!["SELF_OPEN", "SELF_SUBMITTED"].includes(scope.row.state))
        fail(
          "STATE_CONFLICT",
          "Open peer feedback before the manager submits the review",
          409,
        );
      const closesAt = new Date(i.closesAt);
      if (+closesAt <= +e.now || +closesAt > +scope.row.managerDue)
        fail(
          "VALIDATION_FAILED",
          "Peer deadline must be in the future and no later than the manager deadline",
        );
      if (
        await tx.perfPeerRound.findFirst({
          where: { tenantId: e.tenantId, reviewId: i.reviewId },
        })
      )
        fail(
          "STATE_CONFLICT",
          "This review already has a peer feedback round",
          409,
        );
      const template = await tx.perfTemplateVersion.findFirst({
        where: { tenantId: e.tenantId, id: scope.cycle.templateId },
      });
      const row = await tx.perfPeerRound.create({
        data: {
          tenantId: e.tenantId,
          reviewId: i.reviewId,
          closesAt,
          minimum: Math.max(5, scope.cycle.policy.peerMinimum),
          rubric: template.rubric,
          createdBy: e.who.id,
        },
      });
      await audit(tx, e, "PEER_ROUND_CREATE", row.id, 0, i);
      return { id: row.id, version: 0, state: row.state };
    },
  );
};
export const peerNominate = (raw) => {
  const i = C.PeerNominate.parse(raw);
  return run("peer.nominate", i, "hr.performance.read", async (tx, e) => {
    const round = await roundRow(tx, e, i.roundId, { open: true, lock: true });
    const scope = await review(tx, e, round.reviewId, { write: true });
    const candidate = await tx.employee.findFirst({
      where: { tenant_id: e.tenantId, employee_code: i.employeeCode },
    });
    if (!candidate)
      fail("NOT_FOUND", "Active peer employee code not found", 404);
    await person(tx, e.tenantId, candidate.id);
    if (
      [scope.row.employeeId, scope.row.managerId, e.who.id].includes(
        candidate.id,
      )
    )
      fail("INDEPENDENT_PEER_REQUIRED", "Choose an independent colleague", 422);
    if (
      (await tx.perfPeerNomination.count({
        where: { tenantId: e.tenantId, roundId: round.id },
      })) >= 100
    )
      fail("PEER_LIMIT", "At most 100 nominations are allowed", 409);
    if (
      await tx.perfPeerNomination.findFirst({
        where: {
          tenantId: e.tenantId,
          roundId: round.id,
          employeeId: candidate.id,
        },
      })
    )
      fail("STATE_CONFLICT", "This peer is already nominated", 409);
    const row = await tx.perfPeerNomination.create({
      data: {
        tenantId: e.tenantId,
        roundId: round.id,
        employeeId: candidate.id,
        proposedBy: e.who.id,
        reason: i.reason,
      },
    });
    await audit(tx, e, "PEER_NOMINATE", row.id, 0, i);
    return { id: row.id, version: 0, state: row.state };
  });
};
export const peerNominationAction = (raw) => {
  const i = C.PeerNominationAction.parse(raw);
  return run(
    "peer.nomination.action",
    i,
    "hr.performance.peer.manage",
    async (tx, e) => {
      const row = await tx.perfPeerNomination.findFirst({
        where: { tenantId: e.tenantId, id: i.id },
      });
      if (!row) fail("NOT_FOUND", "Nomination not found", 404);
      const round = await roundRow(tx, e, row.roundId, {
        open: true,
        lock: true,
      });
      managerScope(e, await review(tx, e, round.reviewId, { write: true }));
      expected(row, i.expectedVersion);
      if ([row.proposedBy, row.employeeId].includes(e.who.id))
        fail(
          "INDEPENDENT_APPROVER_REQUIRED",
          "Another authorised person must decide this nomination",
          403,
        );
      if (row.state !== "PROPOSED")
        fail("STATE_CONFLICT", "Nomination has already been decided", 409);
      await person(tx, e.tenantId, row.employeeId);
      const state = i.action === "APPROVE" ? "APPROVED" : "DECLINED";
      await tx.perfPeerNomination.update({
        where: { id: row.id },
        data: {
          state,
          version: { increment: 1 },
          decidedBy: e.who.id,
          decisionReason: i.reason,
          decidedAt: e.now,
        },
      });
      await audit(tx, e, "PEER_" + i.action, row.id, row.version + 1, i);
      return { id: row.id, version: row.version + 1, state };
    },
  );
};
export const peerSubmit = (raw) => {
  const i = C.PeerSubmit.parse(raw);
  return run("peer.submit", i, "hr.performance.peer.respond", async (tx, e) => {
    const n = await tx.perfPeerNomination.findFirst({
      where: { tenantId: e.tenantId, id: i.id, employeeId: e.who.id },
    });
    if (!n) fail("NOT_FOUND", "Peer invitation not found", 404);
    const round = await roundRow(tx, e, n.roundId, { open: true, lock: true });
    expected(n, i.expectedVersion);
    if (n.state !== "APPROVED")
      fail(
        "STATE_CONFLICT",
        "Only an approved invitation accepts a response",
        409,
      );
    const subject = await tx.perfReview.findFirst({
      where: { tenantId: e.tenantId, id: round.reviewId },
    });
    const current = await person(tx, e.tenantId, subject.employeeId);
    if (
      [subject.employeeId, subject.managerId, current.managerId].includes(
        e.who.id,
      )
    )
      fail(
        "INDEPENDENT_PEER_REQUIRED",
        "The employee and evaluator cannot act as a peer",
        403,
      );
    const ids = new Set(i.answers.map((a) => a.criterionId));
    if (
      ids.size !== i.answers.length ||
      round.rubric.criteria.length !== ids.size ||
      round.rubric.criteria.some((c) => !ids.has(c.id))
    )
      fail("VALIDATION_FAILED", "Respond once to every criterion");
    if (
      i.answers.some(
        (a) =>
          a.rating !== null &&
          (a.rating < round.rubric.scaleMin ||
            a.rating > round.rubric.scaleMax),
      )
    )
      fail("VALIDATION_FAILED", "Use the published rating anchors");
    await tx.perfPeerResponse.create({
      data: {
        tenantId: e.tenantId,
        roundId: round.id,
        nominationId: n.id,
        authorId: e.who.id,
        answers: json(i.answers),
        digest: digest(i.answers),
        submittedAt: e.now,
      },
    });
    await tx.perfPeerNomination.update({
      where: { id: n.id },
      data: { state: "RESPONDED", version: { increment: 1 } },
    });
    await audit(
      tx,
      e,
      "PEER_SUBMIT",
      n.id,
      n.version + 1,
      i,
      {},
      { aggregateId: round.id, anonymous: true },
    );
    return { id: n.id, version: n.version + 1, state: "RESPONDED" };
  });
};

// One frozen, non-filterable disclosure prevents differencing across rater subsets.
// Free text and rater identities are never included in the aggregate response.
export function aggregatePeerResponses(rubric, responses, minimum) {
  if (responses.length < minimum)
    return { suppressed: true, reason: "MINIMUM_GROUP_NOT_MET", minimum };
  return {
    suppressed: false,
    minimum,
    respondents: responses.length,
    criteria: rubric.criteria.map((c) => {
      const ratings = responses.flatMap((r) =>
        r.answers
          .filter((a) => a.criterionId === c.id && a.rating !== null)
          .map((a) => a.rating),
      );
      if (ratings.length < minimum)
        return { criterionId: c.id, suppressed: true };
      return {
        criterionId: c.id,
        suppressed: false,
        respondents: ratings.length,
        average:
          Math.round(
            (ratings.reduce((n, v) => n + v, 0) / ratings.length) * 100,
          ) / 100,
      };
    }),
  };
}
export const peerClose = (raw) => {
  const i = C.PeerClose.parse(raw);
  return run("peer.close", i, "hr.performance.peer.manage", async (tx, e) => {
    const round = await roundRow(tx, e, i.id, { lock: true });
    managerScope(e, await review(tx, e, round.reviewId));
    expected(round, i.expectedVersion);
    if (round.state !== "OPEN")
      fail("STATE_CONFLICT", "Peer round is already closed", 409);
    if (+e.now < +round.closesAt)
      fail(
        "PEER_WINDOW_OPEN",
        "Allow the frozen response window to finish before closing",
        409,
      );
    const responses = await tx.perfPeerResponse.findMany({
      where: { tenantId: e.tenantId, roundId: round.id },
    });
    const summary = aggregatePeerResponses(
      round.rubric,
      responses,
      round.minimum,
    );
    await tx.perfPeerRound.update({
      where: { id: round.id },
      data: {
        state: "CLOSED",
        version: { increment: 1 },
        closedAt: e.now,
        summary,
      },
    });
    await audit(tx, e, "PEER_CLOSE", round.id, round.version + 1, i);
    return {
      id: round.id,
      version: round.version + 1,
      state: "CLOSED",
      summary,
    };
  });
};
export const peerGet = (raw) => {
  const i = C.APPRAISAL_TOOLS.hr_appraisal_peer_get[1].parse(raw);
  return run(
    "peer.get",
    i,
    "hr.performance.read",
    async (tx, e) => {
      const scope = await review(tx, e, i.reviewId);
      const round = await tx.perfPeerRound.findFirst({
        where: { tenantId: e.tenantId, reviewId: i.reviewId },
      });
      if (!round) return { round: null, nominations: [] };
      const rows = await tx.perfPeerNomination.findMany({
        where: {
          tenantId: e.tenantId,
          roundId: round.id,
          ...(scope.self ? { proposedBy: e.who.id } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      const employees = await tx.employee.findMany({
        where: {
          tenant_id: e.tenantId,
          id: { in: rows.map((n) => n.employeeId) },
        },
        select: { id: true, employee_code: true },
      });
      return {
        round: {
          id: round.id,
          version: round.version,
          state: round.state,
          closesAt: round.closesAt,
          minimum: round.minimum,
          summary:
            scope.self && !scope.row.releasedRevisionId ? null : round.summary,
        },
        nominations: rows.map((n) => ({
          id: n.id,
          version: n.state === "RESPONDED" ? 1 : n.version,
          reason: n.reason,
          employeeCode: employees.find((p) => p.id === n.employeeId)
            ?.employee_code,
          // A nominator cannot infer individual participation from status or version.
          state: n.state === "RESPONDED" ? "APPROVED" : n.state,
          canDecide:
            !scope.self &&
            has(e, "hr.performance.peer.manage") &&
            n.state === "PROPOSED" &&
            ![n.proposedBy, n.employeeId].includes(e.who.id),
        })),
      };
    },
    { read: true },
  );
};
export const peerQueue = (raw) => {
  const i = C.APPRAISAL_TOOLS.hr_appraisal_peer_queue[1].parse(raw);
  return run(
    "peer.queue",
    i,
    "hr.performance.peer.respond",
    async (tx, e) => {
      const rows = await tx.perfPeerNomination.findMany({
        where: {
          tenantId: e.tenantId,
          employeeId: e.who.id,
          state: { in: ["APPROVED", "RESPONDED"] },
          ...(i.cursor ? { id: { gt: i.cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: 26,
      });
      const items = [];
      for (const n of rows.slice(0, 25)) {
        const round = await roundRow(tx, e, n.roundId);
        const subject = await tx.perfReview.findFirst({
          where: { tenantId: e.tenantId, id: round.reviewId },
        });
        const employee = await tx.employee.findFirst({
          where: { tenant_id: e.tenantId, id: subject.employeeId },
          select: { employee_code: true },
        });
        const response = await tx.perfPeerResponse.findFirst({
          where: {
            tenantId: e.tenantId,
            nominationId: n.id,
            authorId: e.who.id,
          },
        });
        items.push({
          id: n.id,
          version: n.version,
          state: n.state,
          employeeCode: employee?.employee_code,
          roundState: round.state,
          closesAt: round.closesAt,
          rubric: round.rubric,
          answers: response?.answers ?? null,
        });
      }
      return { items, nextCursor: rows.length > 25 ? items.at(-1).id : null };
    },
    { read: true },
  );
};
