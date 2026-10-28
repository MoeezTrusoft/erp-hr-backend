import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as P from "../../src/services/appraisals/peers.js";
const key = () => randomUUID();
export async function peerRegressions(
  t,
  { as, tenant, other, people, db, reviewId },
) {
  let round;
  const nominations = [];
  const raters = ["CALIBRATOR", "RELEASER", "APPEAL", "BUDGET", "EXECUTOR"];
  const closesAt = new Date(Date.now() + 60000).toISOString();
  await t.test(
    "Peer nominations require an independent current evaluator and do not expose participation",
    async () => {
      await assert.rejects(
        as("EMPLOYEE", () =>
          P.peerRoundCreate({ requestKey: key(), reviewId, closesAt }),
        ),
        (e) => e.code === "FORBIDDEN",
      );
      round = await as("MANAGER", () =>
        P.peerRoundCreate({ requestKey: key(), reviewId, closesAt }),
      );
      await assert.rejects(
        as("HR", () =>
          P.peerNominate({
            requestKey: key(),
            roundId: round.id,
            employeeCode: people.EMPLOYEE.employee_code,
            reason: "Self is not a peer",
          }),
        ),
        (e) => e.code === "INDEPENDENT_PEER_REQUIRED",
      );
      for (const rater of raters) {
        const n = await as("EMPLOYEE", () =>
          P.peerNominate({
            requestKey: key(),
            roundId: round.id,
            employeeCode: people[rater].employee_code,
            reason: "Worked together on accepted deliverables",
          }),
        );
        await assert.rejects(
          as("EMPLOYEE", () =>
            P.peerNominationAction({
              requestKey: key(),
              id: n.id,
              expectedVersion: 0,
              action: "APPROVE",
              reason: "Cannot self-approve nomination",
            }),
          ),
          (e) => e.code === "FORBIDDEN",
        );
        const approved = await as("MANAGER", () =>
          P.peerNominationAction({
            requestKey: key(),
            id: n.id,
            expectedVersion: 0,
            action: "APPROVE",
            reason: "Relevant first-hand observations",
          }),
        );
        nominations.push(approved);
      }
      assert.equal(
        (await as("CALIBRATOR", () => P.peerQueue({}))).items.length,
        1,
      );
      await assert.rejects(
        as("CALIBRATOR", () => P.peerQueue({}), undefined, other),
        (e) => e.status === 403,
      );
      const before = await as("EMPLOYEE", () => P.peerGet({ reviewId }));
      const submission = {
        requestKey: key(),
        id: nominations[0].id,
        expectedVersion: 1,
        answers: [
          {
            criterionId: "delivery",
            rating: 4,
            observation: "Confidential direct observation",
          },
        ],
      };
      await assert.rejects(
        as("BUDGET", () => P.peerSubmit(submission)),
        (e) => e.code === "NOT_FOUND",
      );
      await as("CALIBRATOR", () => P.peerSubmit(submission));
      await as("CALIBRATOR", () => P.peerSubmit(submission));
      assert.deepEqual(
        await as("EMPLOYEE", () => P.peerGet({ reviewId })),
        before,
        "Submission must not expose an individual participation signal",
      );
      assert.equal(
        (await as("CALIBRATOR", () => P.peerQueue({}))).items[0].answers[0]
          .observation,
        "Confidential direct observation",
      );
      await assert.rejects(
        as("MANAGER", () =>
          P.peerClose({
            requestKey: key(),
            id: round.id,
            expectedVersion: 0,
            reason: "Do not cherry-pick early responses",
          }),
        ),
        (e) => e.code === "PEER_WINDOW_OPEN",
      );
    },
  );
  await t.test(
    "Closed peer disclosure requires five observations and excludes names, notes and per-rater scores",
    async (p) => {
      for (let n = 1; n < raters.length; n++)
        await as(raters[n], () =>
          P.peerSubmit({
            requestKey: key(),
            id: nominations[n].id,
            expectedVersion: 1,
            answers: [
              {
                criterionId: "delivery",
                rating: n === 1 ? 5 : 4,
                observation: "Private peer " + n,
              },
            ],
          }),
        );
      p.mock.timers.enable({ apis: ["Date"], now: +new Date(closesAt) + 1000 });
      const closed = await as("MANAGER", () =>
        P.peerClose({
          requestKey: key(),
          id: round.id,
          expectedVersion: 0,
          reason: "Response window completed",
        }),
      );
      p.mock.timers.reset();
      assert.equal(closed.summary.respondents, 5);
      assert.equal(closed.summary.criteria[0].average, 4.2);
      assert.equal(JSON.stringify(closed.summary).includes("Private"), false);
      assert.equal(
        (await as("EMPLOYEE", () => P.peerGet({ reviewId }))).round.summary,
        null,
      );
      assert.deepEqual(
        (await as("MANAGER", () => P.peerGet({ reviewId }))).round.summary,
        closed.summary,
      );
      await assert.rejects(
        db((tx) =>
          tx.perfPeerRound.update({
            where: { id: round.id },
            data: {
              version: { increment: 1 },
              summary: { suppressed: false, respondents: 1 },
            },
          }),
        ),
      );
      const response = await db((tx) =>
        tx.perfPeerResponse.findFirst({
          where: { tenantId: tenant, roundId: round.id },
        }),
      );
      await assert.rejects(
        db((tx) =>
          tx.perfPeerResponse.update({
            where: { id: response.id },
            data: { answers: [] },
          }),
        ),
      );
      await assert.rejects(
        db((tx) => tx.perfPeerResponse.delete({ where: { id: response.id } })),
      );
      assert.equal(
        await db((tx) =>
          tx.perfPeerResponse.count({
            where: { tenantId: tenant, roundId: round.id },
          }),
        ),
        5,
      );
      const events = await db((tx) =>
        tx.outboxEvent.findMany({
          where: {
            tenantId: tenant,
            eventName: "hr.performance.peer.submitted.v1",
          },
        }),
      );
      assert.equal(events.length, 5);
      for (const event of events) {
        assert.equal(event.aggregateId, round.id);
        assert.deepEqual(event.payload.actor, {
          type: "service",
          id: "svc:hr-appraisals-peer",
        });
        assert.equal(event.payload.payload.aggregateVersion, 0);
        assert.equal(JSON.stringify(event.payload).includes("Private"), false);
      }
    },
  );
  await t.test(
    "Peer aggregate suppresses both small rounds and small criterion groups",
    () => {
      const rubric = { criteria: [{ id: "delivery" }] };
      const responses = Array.from({ length: 5 }, () => ({
        answers: [{ criterionId: "delivery", rating: 4 }],
      }));
      assert.deepEqual(
        P.aggregatePeerResponses(rubric, responses.slice(0, 4), 5),
        { suppressed: true, reason: "MINIMUM_GROUP_NOT_MET", minimum: 5 },
      );
      responses[0].answers[0].rating = null;
      assert.deepEqual(
        P.aggregatePeerResponses(rubric, responses, 5).criteria,
        [{ criterionId: "delivery", suppressed: true }],
      );
    },
  );
}
