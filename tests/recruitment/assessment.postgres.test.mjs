import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";

const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
) {
  throw new Error(
    "Use the isolated local recruitment database and non-owner test role",
  );
}
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.HR_RECRUITMENT_ONSITE_TEST = "on";
process.env.HR_RECRUITMENT_EVALUATION_FORMS = "on";
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const catalog =
  await import("../../src/services/candidate-assessment/catalog.js");
const sessions =
  await import("../../src/services/candidate-assessment/sessions.js");
const resultService =
  await import("../../src/services/candidate-assessment/results.js");
const forms = await import("../../src/services/candidate-assessment/forms.js");
const { setInterviewOutcome } =
  await import("../../src/services/interviewMgmt.service.js");
const { upsertInterviewScorecard } =
  await import("../../src/services/interview-scorecard.service.js");
const { EvaluationForm, TestBlueprint } =
  await import("@trusoft/contracts/recruitment-assessment");
const tenant = randomUUID(),
  other = randomUUID(),
  staff = {};
const grants = [
  "hr.recruitment.read",
  "hr.recruitment.update",
  "hr.recruitment.reception",
  ...["read", "create", "update", "publish", "approve", "admin"].map(
    (x) => "hr.recruitment.assessment." + x,
  ),
];
const context = (role, tenantId = tenant, permissions = grants) => ({
  actorVerified: true,
  user: {
    tenantId,
    userId: staff[role].userId,
    employeeId: staff[role].id,
    roles: [role],
  },
  permissions,
});
const as = (role, fn, permissions = grants) =>
  mcpCtx.run(context(role, tenant, permissions), fn);
const tx = (fn, tenantId = tenant) =>
  mcpCtx.run({ user: { tenantId } }, () =>
    tenantTransaction(prisma, fn, { tenantId, txOptions: { timeout: 60000 } }),
  );
const kiosk = (fn) => tx((db) => fn(db, { tenantId: tenant, now: new Date() }));
let skill, application, interview, blueprint, station, issued, started, result;
const anchors = {
  1: "No evidence",
  2: "Needs support",
  3: "Works independently",
  4: "Consistent results",
  5: "Coaches others",
};
const form = EvaluationForm.parse({
  sections: [
    {
      key: "editing",
      title: "Editing",
      criteria: [
        {
          key: "accuracy",
          label: "Accuracy",
          description: "Corrects errors in supplied copy",
          competencyKey: "copy",
          weight: 1,
          anchors,
        },
      ],
    },
  ],
});

test(
  "onsite assessment and independent interview forms use real tenant-enforced transactions",
  { timeout: 240000 },
  async (t) => {
    await tx(async (db) => {
      for (const role of [
        "RECRUITER",
        "HIRING_MANAGER",
        "HR_HEAD",
        "INTERVIEWER",
        "PANELIST",
        "RECEPTIONIST",
      ]) {
        staff[role] = await db.employee.create({
          data: {
            tenant_id: tenant,
            employee_code: "EMP-" + role,
            employeeCategory: "EMPLOYEE",
            userId: randomInt(100000, 1000000000),
            first_name: "Fictional",
            status: "Active",
            employement_status: "Active",
            interviewerTrainedAt: new Date(),
            recruitmentSiteRefs: ["TEST"],
          },
        });
      }
      skill = await db.skill.create({
        data: { tenantId: tenant, name: "Editing-" + randomUUID() },
      });
      const requisition = await db.jobRequisition.create({
        data: {
          tenantId: tenant,
          title: "Test editor",
          requestedById: staff.HIRING_MANAGER.id,
        },
      });
      const candidate = await db.candidate.create({
        data: {
          tenantId: tenant,
          firstName: "Fictional",
          email: randomUUID() + "@example.invalid",
        },
      });
      application = await db.application.create({
        data: {
          tenantId: tenant,
          candidateId: candidate.id,
          jobRequisitionId: requisition.id,
        },
      });
      interview = await db.interview.create({
        data: {
          tenantId: tenant,
          applicationId: application.id,
          interviewType: "ONSITE",
          scheduledAt: new Date(Date.now() + 86400000),
          assessmentRequired: true,
          assessmentStatus: "REQUIRED",
          formTemplateVersion: 1,
          formSnapshot: form,
          interviewers: {
            create: ["INTERVIEWER", "PANELIST"].map((role) => ({
              tenantId: tenant,
              employeeId: staff[role].id,
            })),
          },
        },
      });
    });

    await t.test(
      "reception site administration is scoped, audited and rejects stale overwrites",
      async () => {
        await as("HR_HEAD", () =>
          sessions.workstationRegister({
            label: "Reception scope fixture",
            siteRef: "TEST",
          }),
        );
        const permissions = ["hr.recruitment.reception"];
        const listed = await as("HR_HEAD", () =>
          sessions.receptionStaffList({ q: "EMP-RECEPTIONIST" }),
        );
        assert.equal(listed.items.length, 1);
        assert.deepEqual(Object.keys(listed.items[0]).sort(), [
          "employeeCode",
          "employeeId",
          "name",
          "siteRefs",
        ]);
        await assert.rejects(
          as(
            "RECEPTIONIST",
            () => sessions.receptionStaffList({}),
            permissions,
          ),
          /Permission required/i,
        );
        const first = await as("HR_HEAD", () =>
          sessions.receptionSitesAssign({
            employeeId: staff.RECEPTIONIST.id,
            siteRefs: [],
            expectedSiteRefs: ["TEST"],
          }),
        );
        assert.deepEqual(first.siteRefs, []);
        assert.deepEqual(
          (
            await as(
              "RECEPTIONIST",
              () => sessions.receptionWorkstations(),
              permissions,
            )
          ).items,
          [],
        );
        await as("HR_HEAD", () =>
          sessions.receptionSitesAssign({
            employeeId: staff.RECEPTIONIST.id,
            siteRefs: ["TEST"],
            expectedSiteRefs: [],
          }),
        );
        await assert.rejects(
          as("HR_HEAD", () =>
            sessions.receptionSitesAssign({
              employeeId: staff.RECEPTIONIST.id,
              siteRefs: [],
              expectedSiteRefs: [],
            }),
          ),
          /changed/i,
        );
        await assert.rejects(
          as("HR_HEAD", () =>
            sessions.receptionSitesAssign({
              employeeId: staff.RECEPTIONIST.id,
              siteRefs: ["UNKNOWN"],
            }),
          ),
          /Register.*site/i,
        );
        assert.equal(
          (
            await as(
              "RECEPTIONIST",
              () => sessions.receptionWorkstations(),
              permissions,
            )
          ).items.length,
          1,
        );
        const audit = await tx((db) =>
          db.log.findFirst({
            where: {
              tenantId: tenant,
              module: "Recruitment kiosk administration",
              type: "ASSIGN",
            },
            orderBy: { id: "desc" },
          }),
        );
        assert.equal(audit.actionById, staff.HR_HEAD.id);
        assert.equal(JSON.parse(audit.notes).employeeId, staff.RECEPTIONIST.id);
      },
    );

    await t.test(
      "item authors cannot publish their own work and foreign tenants cannot see it",
      async () => {
        const items = [];
        for (const competencyKey of ["copy", "numbers"])
          for (let n = 0; n < 3; n++) {
            let item = await as("RECRUITER", () =>
              catalog.itemCreate({
                item: {
                  itemCode: competencyKey + n,
                  type: "SINGLE",
                  stem: "Which answer correctly completes this job task?",
                  options: [
                    { key: "a", text: "Correct answer" },
                    { key: "b", text: "Incorrect answer" },
                  ],
                  answerKey: { keys: ["a"] },
                  difficulty: "EASY",
                  competencyKey,
                  skillId: skill.id,
                  jobFamily: "EDITOR",
                  rationale: "Measures a required editing task.",
                  discussionPrompt: competencyKey === "copy",
                },
              }),
            );
            assert.equal(item.answerKey, undefined);
            item = await as("RECRUITER", () =>
              catalog.itemSubmit({
                id: item.id,
                expectedVersion: item.revision,
              }),
            );
            await assert.rejects(
              as("RECRUITER", () =>
                catalog.itemReview({
                  id: item.id,
                  expectedVersion: item.revision,
                  approve: true,
                  reason: "Independently reviewed",
                }),
              ),
              /independent/i,
            );
            item = await as("HR_HEAD", () =>
              catalog.itemReview({
                id: item.id,
                expectedVersion: item.revision,
                approve: true,
                reason: "Reviewed against the work sample",
              }),
            );
            items.push(item);
          }
        const foreign = await tx(
          (db) => db.candidateTestItem.findMany({ where: { id: items[0].id } }),
          other,
        );
        assert.equal(foreign.length, 0);
        await assert.rejects(
          tx((db) =>
            db.candidateTestItem.update({
              where: { id: items[0].id },
              data: { stem: "Changed after publication" },
            }),
          ),
          /immutable|published|HR-60/i,
        );
        await assert.rejects(
          as("RECRUITER", () => catalog.itemsList({}), []),
          /Permission/,
        );
      },
    );

    await t.test(
      "blueprints need independent approvers and enough reviewed items",
      async () => {
        blueprint = await as("RECRUITER", () =>
          catalog.blueprintCreate({
            blueprint: TestBlueprint.parse({
              name: "Editor test",
              jobFamily: "EDITOR",
              sections: ["copy", "numbers"].map((key) => ({
                key,
                competencyKey: key,
                itemCount: 1,
                weight: 1,
                difficultyMix: { EASY: 100, MEDIUM: 0, HARD: 0 },
              })),
            }),
          }),
        );
        await assert.rejects(
          as("RECRUITER", () =>
            catalog.blueprintPublish({
              id: blueprint.id,
              expectedVersion: blueprint.revision,
            }),
          ),
          /approvals/,
        );
        blueprint = await as("HIRING_MANAGER", () =>
          catalog.blueprintApprove({
            id: blueprint.id,
            expectedVersion: blueprint.revision,
            role: "HIRING_MANAGER",
          }),
        );
        blueprint = await as("HR_HEAD", () =>
          catalog.blueprintApprove({
            id: blueprint.id,
            expectedVersion: blueprint.revision,
            role: "HR",
          }),
        );
        blueprint = await as("HR_HEAD", () =>
          catalog.blueprintPublish({
            id: blueprint.id,
            expectedVersion: blueprint.revision,
          }),
        );
        await as("HR_HEAD", () =>
          catalog.blueprintLink({
            blueprintId: blueprint.id,
            scopeType: "REQUISITION",
            scopeId: String(application.jobRequisitionId),
          }),
        );
      },
    );

    await t.test(
      "feedback is blocked until the assessment permits the interview",
      async () => {
        await assert.rejects(
          as("INTERVIEWER", () =>
            forms.formSave(
              {
                interviewId: interview.id,
                expectedVersion: 0,
                criterionScores: [{ key: "accuracy", rating: 3, evidence: "" }],
                coiDeclared: true,
                recommendation: "HIRE",
                notes: "",
              },
              { submit: true },
            ),
          ),
          /assessment|test/i,
        );
        await assert.rejects(
          tx((db) =>
            db.interview.update({
              where: { id: interview.id },
              data: { status: "COMPLETED" },
            }),
          ),
          /HR-6001|assessment/i,
        );
      },
    );

    await t.test(
      "a kiosk admits only one active candidate and reception cannot grant accommodations",
      async () => {
        const pc = await as("HR_HEAD", () =>
          sessions.workstationRegister({
            label: "Shared kiosk",
            siteRef: "TEST",
          }),
        );
        const arrivals = await tx(async (db) => {
          const created = [];
          for (let index = 0; index < 2; index++) {
            const candidate = await db.candidate.create({
              data: {
                tenantId: tenant,
                firstName: "Fictional",
                email: randomUUID() + "@example.invalid",
              },
            });
            const app = await db.application.create({
              data: {
                tenantId: tenant,
                candidateId: candidate.id,
                jobRequisitionId: application.jobRequisitionId,
              },
            });
            created.push(
              await db.interview.create({
                data: {
                  tenantId: tenant,
                  applicationId: app.id,
                  siteRef: "TEST",
                  interviewType: "ONSITE",
                  scheduledAt: new Date(),
                  assessmentRequired: true,
                  assessmentStatus: "REQUIRED",
                },
              }),
            );
          }
          return created;
        });
        const receptionGrants = ["hr.recruitment.reception"];
        for (const row of arrivals)
          await as(
            "RECEPTIONIST",
            () =>
              sessions.checkIn({
                interviewId: row.id,
                consent: true,
                idType: "CNIC",
                idLast4: "1234",
              }),
            receptionGrants,
          );
        await assert.rejects(
          as(
            "RECEPTIONIST",
            () =>
              sessions.sessionIssue({
                interviewId: arrivals[0].id,
                workstationId: pc.id,
                extraTimePct: 10,
                reason: "Requested accommodation",
              }),
            receptionGrants,
          ),
          /recruiter.*authorize/i,
        );
        const attempts = await Promise.allSettled(
          arrivals.map((row) =>
            as(
              "RECEPTIONIST",
              () =>
                sessions.sessionIssue({
                  interviewId: row.id,
                  workstationId: pc.id,
                }),
              receptionGrants,
            ),
          ),
        );
        assert.equal(
          attempts.filter((attempt) => attempt.status === "fulfilled").length,
          1,
        );
        assert.equal(
          attempts.filter((attempt) => attempt.status === "rejected").length,
          1,
        );
        const active = await tx((db) =>
          db.candidateTestSession.findMany({
            where: {
              tenantId: tenant,
              workstationId: pc.id,
              status: { in: ["ISSUED", "IN_PROGRESS", "PAUSED"] },
            },
          }),
        );
        assert.equal(active.length, 1);
        const otherArrival = arrivals.find(
          (row) => row.id !== active[0].interviewId,
        );
        await assert.rejects(
          as(
            "RECEPTIONIST",
            () =>
              sessions.sessionIssue({
                interviewId: otherArrival.id,
                workstationId: pc.id,
              }),
            receptionGrants,
          ),
          /already has an active session/i,
        );
        const renewed = await as(
          "RECEPTIONIST",
          () =>
            sessions.sessionIssue({
              interviewId: active[0].interviewId,
              workstationId: pc.id,
              reason: "Candidate lost the original code",
            }),
          receptionGrants,
        );
        assert.equal(renewed.sessionId, active[0].id);
        await assert.rejects(
          as(
            "RECEPTIONIST",
            () =>
              sessions.sessionControl("EXTEND", {
                id: renewed.sessionId,
                expectedVersion: active[0].revision + 1,
                extraTimePct: 10,
                reason: "Requested accommodation",
              }),
            receptionGrants,
          ),
          /recruiter.*authorize/i,
        );
        const row = active[0];
        const {
          id: _id,
          createdAt: _created,
          updatedAt: _updated,
          ...duplicate
        } = row;
        await assert.rejects(
          tx((db) =>
            db.candidateTestSession.create({
              data: {
                ...duplicate,
                interviewId: otherArrival.id,
                applicationId: otherArrival.applicationId,
                sessionCodeHash: null,
              },
            }),
          ),
          /unique|constraint/i,
        );
      },
    );

    await t.test(
      "workstation-bound one-time codes serve no answer key and score server-side",
      async () => {
        station = await as("HR_HEAD", () =>
          sessions.workstationRegister({ label: "Test PC", siteRef: "TEST" }),
        );
        await as("RECRUITER", () =>
          sessions.checkIn({
            interviewId: interview.id,
            consent: true,
            idType: "CNIC",
            idLast4: "1234",
          }),
        );
        issued = await as("RECRUITER", () =>
          sessions.sessionIssue({
            interviewId: interview.id,
            workstationId: station.id,
          }),
        );
        await assert.rejects(
          kiosk((db, env) =>
            sessions.kioskStart(
              db,
              env,
              { id: station.id + 1 },
              { code: issued.code, consent: true },
            ),
          ),
          /unavailable/,
        );
        started = await kiosk((db, env) =>
          sessions.kioskStart(db, env, station, {
            code: issued.code,
            consent: true,
          }),
        );
        await assert.rejects(
          kiosk((db, env) =>
            sessions.kioskStart(db, env, station, {
              code: issued.code,
              consent: true,
            }),
          ),
          /unavailable/,
        );
        for (let index = 0; index < started.itemCount; index++) {
          const question = await kiosk(async (db, env) =>
            sessions.kioskOperate(
              db,
              env,
              await sessions.kioskSession(
                db,
                env,
                station,
                started.id,
                started.accessToken,
              ),
              "ITEM",
              { index },
            ),
          );
          assert.equal(question.answerKey, undefined);
          assert.equal(question.rationale, undefined);
          await kiosk(async (db, env) => {
            env.now = new Date(Date.now() + 3000);
            return sessions.kioskOperate(
              db,
              env,
              await sessions.kioskSession(
                db,
                env,
                station,
                started.id,
                started.accessToken,
              ),
              "RESPONSE",
              { itemId: question.itemId, answer: ["a"] },
            );
          });
        }
        await kiosk(async (db, env) =>
          sessions.kioskOperate(
            db,
            env,
            await sessions.kioskSession(
              db,
              env,
              station,
              started.id,
              started.accessToken,
            ),
            "SUBMIT",
          ),
        );
        result = await tx((db) =>
          db.candidateTestResult.findUnique({
            where: { sessionId: started.id },
          }),
        );
        assert.equal(result.band, "PASSED");
        assert.equal(result.scorePct, 100);
        const stored = await tx((db) =>
          db.interview.findUnique({ where: { id: interview.id } }),
        );
        assert.equal(stored.assessmentResultId, result.id);
        await assert.rejects(
          kiosk(async (db, env) =>
            sessions.kioskOperate(
              db,
              env,
              await sessions.kioskSession(
                db,
                env,
                station,
                started.id,
                started.accessToken,
              ),
              "RESPONSE",
              { itemId: 1, answer: ["a"] },
            ),
          ),
          /ended/,
        );
      },
    );

    await t.test(
      "recent results are reused and a latest approved retest is consumed once across interviews",
      async () => {
        const source = await tx((db) =>
          db.candidateTestSession.findUnique({ where: { id: started.id } }),
        );
        const arrival = async () => {
          const row = await tx((db) =>
            db.interview.create({
              data: {
                tenantId: tenant,
                applicationId: application.id,
                siteRef: "TEST",
                interviewType: "ONSITE",
                scheduledAt: new Date(),
                assessmentRequired: true,
                assessmentStatus: "REQUIRED",
              },
            }),
          );
          await as("RECRUITER", () =>
            sessions.checkIn({
              interviewId: row.id,
              consent: true,
              idType: "CNIC",
              idLast4: "1234",
            }),
          );
          return row;
        };
        const reusedInterview = await arrival();
        const reused = await as("RECRUITER", () =>
          sessions.sessionIssue({
            interviewId: reusedInterview.id,
            workstationId: station.id,
          }),
        );
        assert.equal(reused.reusedResultId, result.id);
        assert.equal(reused.code, undefined);
        const stored = await tx((db) =>
          db.interview.findUnique({ where: { id: reusedInterview.id } }),
        );
        assert.equal(stored.assessmentResultId, result.id);
        const approvedInterview = await arrival();
        await tx(async (db) => {
          const prior = await db.candidateTestSession.create({
            data: {
              tenantId: tenant,
              applicationId: application.id,
              candidateId: source.candidateId,
              interviewId: approvedInterview.id,
              blueprintId: source.blueprintId,
              blueprintVersion: source.blueprintVersion,
              blueprintSnapshot: source.blueprintSnapshot,
              workstationId: station.id,
              issuedById: staff.RECRUITER.id,
              itemOrder: [],
              status: "SUBMITTED",
              issuedAt: new Date(),
              submittedAt: new Date(),
              codeExpiresAt: new Date(),
            },
          });
          await db.candidateTestResult.create({
            data: {
              tenantId: tenant,
              sessionId: prior.id,
              applicationId: application.id,
              interviewId: approvedInterview.id,
              rawScore: 0,
              maxScore: 2,
              mustPassFailed: false,
              integrityFlagCount: 0,
              scorePct: 0,
              sectionScores: [],
              band: "FAILED",
              decision: "RETEST",
              decidedById: staff.RECRUITER.id,
              decisionReason: "Device problem reviewed; authorize one retest",
              decidedAt: new Date(),
            },
          });
        });
        const retryInterview = await arrival();
        const retry = await as("RECRUITER", () =>
          sessions.sessionIssue({
            interviewId: retryInterview.id,
            workstationId: station.id,
          }),
        );
        assert.ok(retry.code);
        const otherInterview = await arrival(),
          pc = await as("HR_HEAD", () =>
            sessions.workstationRegister({
              label: "Second attempt PC",
              siteRef: "TEST",
            }),
          );
        await assert.rejects(
          as("RECRUITER", () =>
            sessions.sessionIssue({
              interviewId: otherInterview.id,
              workstationId: pc.id,
            }),
          ),
          /already has an active assessment/,
        );
        const retryStarted = await kiosk((db, env) =>
          sessions.kioskStart(db, env, station, {
            code: retry.code,
            consent: true,
          }),
        );
        await kiosk(async (db, env) =>
          sessions.kioskOperate(
            db,
            env,
            await sessions.kioskSession(
              db,
              env,
              station,
              retryStarted.id,
              retryStarted.accessToken,
            ),
            "SUBMIT",
          ),
        );
        await assert.rejects(
          as("RECRUITER", () =>
            sessions.sessionIssue({
              interviewId: otherInterview.id,
              workstationId: pc.id,
            }),
          ),
          /cooldown/,
        );
      },
    );
    async function timedSession(durations = [1, 1], extraTimePct = 0) {
      const source = await tx((db) =>
        db.candidateTestSession.findUnique({ where: { id: started.id } }),
      );
      const pc = await as("HR_HEAD", () =>
        sessions.workstationRegister({
          label: "Timed fixture",
          siteRef: "TEST",
        }),
      );
      await tx(async (db) => {
        const candidate = await db.candidate.create({
          data: {
            tenantId: tenant,
            firstName: "Fictional",
            email: randomUUID() + "@example.invalid",
          },
        });
        const app = await db.application.create({
          data: {
            tenantId: tenant,
            candidateId: candidate.id,
            jobRequisitionId: application.jobRequisitionId,
          },
        });
        const i = await db.interview.create({
          data: {
            tenantId: tenant,
            applicationId: app.id,
            interviewType: "ONSITE",
            siteRef: "TEST",
            scheduledAt: new Date(),
            assessmentRequired: true,
            assessmentStatus: "REQUIRED",
          },
        });
        await db.candidateTestSession.create({
          data: {
            tenantId: tenant,
            applicationId: app.id,
            candidateId: candidate.id,
            interviewId: i.id,
            blueprintId: source.blueprintId,
            blueprintVersion: source.blueprintVersion,
            blueprintSnapshot: {
              ...source.blueprintSnapshot,
              durationMin: 20,
              sections: source.blueprintSnapshot.sections.map(
                (section, index) => ({
                  ...section,
                  ...(durations[index] == null
                    ? {}
                    : { durationMin: durations[index] }),
                }),
              ),
            },
            workstationId: pc.id,
            issuedById: staff.RECRUITER.id,
            itemOrder: [],
            extraTimePct,
            sessionCodeHash: sessions.tokenHash(pc.id + ":123456"),
            codeExpiresAt: new Date(Date.now() + 900000),
          },
        });
      });
      const state = await kiosk((db, env) =>
        sessions.kioskStart(db, env, pc, { code: "123456", consent: true }),
      );
      const operate = (operation, input = {}, now = new Date()) =>
        tx(async (db) => {
          const env = { tenantId: tenant, now };
          const row = await sessions.kioskSession(
            db,
            env,
            pc,
            state.id,
            state.accessToken,
          );
          return sessions.kioskOperate(db, env, row, operation, input);
        });
      return { state, operate };
    }
    await t.test(
      "section clocks freeze the draw order and deny future or closed section answers in the API and database",
      async () => {
        const { state, operate } = await timedSession();
        assert.equal(state.section.key, "copy");
        assert.equal(
          +new Date(state.section.deadlineAt) - +new Date(state.startedAt),
          60000,
        );
        assert.equal(
          (await operate("ITEM", { index: 1 })).sectionChanged,
          true,
        );
        const question = await operate("ITEM", { index: 0 });
        await operate("RESPONSE", { itemId: question.itemId, answer: ["a"] });
        const next = await operate("NEXT_SECTION", {
          sectionKey: "copy",
          confirmed: true,
        });
        assert.equal(next.section.key, "numbers");
        assert.equal(next.currentIndex, 1);
        assert.equal(
          (
            await operate("NEXT_SECTION", {
              sectionKey: "copy",
              confirmed: true,
            })
          ).sectionChanged,
          true,
        );
        assert.equal(
          (
            await operate("RESPONSE", {
              itemId: question.itemId,
              answer: ["b"],
            })
          ).sectionChanged,
          true,
        );
        await assert.rejects(
          tx((db) =>
            db.candidateTestResponse.update({
              where: {
                sessionId_itemId: {
                  sessionId: state.id,
                  itemId: question.itemId,
                },
              },
              data: { answer: ["b"] },
            }),
          ),
          /section is not accepting/,
        );
        const rows = await tx(
          async (db) =>
            await db.$queryRawUnsafe(
              'SELECT * FROM "CandidateTestSessionSection" WHERE "sessionId"=$1 ORDER BY "sectionIndex"',
              state.id,
            ),
        );
        assert.equal(rows.length, 2);
        assert.ok(rows[0].closedAt);
        const foreign = await tx(
          async (db) =>
            await db.$queryRawUnsafe(
              'SELECT * FROM "CandidateTestSessionSection" WHERE "sessionId"=$1',
              state.id,
            ),
          other,
        );
        assert.equal(foreign.length, 0);
        await assert.rejects(
          tx(
            async (db) =>
              await db.$executeRawUnsafe(
                'UPDATE "CandidateTestSessionSection" SET "closedAt"=NULL WHERE "sessionId"=$1 AND "sectionIndex"=0',
                state.id,
              ),
          ),
          /immutable/,
        );
        await operate("SUBMIT");
      },
    );
    await t.test(
      "a request exactly at the section deadline advances atomically without accepting a stale answer",
      async () => {
        const { state, operate } = await timedSession();
        const question = await operate("ITEM", { index: 0 });
        const transition = await operate(
          "RESPONSE",
          { itemId: question.itemId, answer: ["a"] },
          new Date(state.section.deadlineAt),
        );
        assert.equal(transition.sectionChanged, true);
        assert.equal(transition.section.key, "numbers");
        const stored = await tx((db) =>
          db.candidateTestResponse.findMany({ where: { sessionId: state.id } }),
        );
        assert.equal(stored.length, 0);
        const refreshed = await operate(
          "STATE",
          {},
          new Date(+new Date(state.section.deadlineAt) + 5000),
        );
        assert.equal(refreshed.section.key, "numbers");
        assert.equal(refreshed.section.remainingSeconds, 55);
        const ended = await operate(
          "STATE",
          {},
          new Date(+new Date(state.section.deadlineAt) + 60000),
        );
        assert.equal(ended.status, "EXPIRED");
        assert.equal(ended.section, null);
        const result = await tx((db) =>
          db.candidateTestResult.findUnique({ where: { sessionId: state.id } }),
        );
        assert.equal(result.band, "INCOMPLETE");
      },
    );
    await t.test(
      "offline time does not restart a section and overall expiry still ends an untimed section",
      async () => {
        const timed = await timedSession();
        const ended = await timed.operate(
          "HEARTBEAT",
          {},
          new Date(+new Date(timed.state.startedAt) + 180000),
        );
        assert.equal(ended.status, "EXPIRED");
        const mixed = await timedSession([1, null]);
        const second = await mixed.operate(
          "STATE",
          {},
          new Date(+new Date(mixed.state.startedAt) + 90000),
        );
        assert.equal(second.section.timed, false);
        assert.equal(+second.section.deadlineAt, +mixed.state.deadlineAt);
        assert.equal(
          (await mixed.operate("STATE", {}, new Date(mixed.state.deadlineAt)))
            .status,
          "EXPIRED",
        );
      },
    );
    await t.test(
      "pause freezes the section, resume preserves remaining time and approved accommodation extends current and future sections",
      async () => {
        const { state, operate } = await timedSession([1, 1], 10);
        assert.equal(+state.section.deadlineAt - +state.startedAt, 66000);
        const paused = await as("RECRUITER", () =>
          sessions.sessionControl("PAUSE", {
            id: state.id,
            expectedVersion: state.revision,
            reason: "Fixture pause",
          }),
        );
        const later = await operate(
          "STATE",
          {},
          new Date(Date.now() + 86400000),
        );
        assert.equal(
          later.section.remainingSeconds,
          paused.section.remainingSeconds,
        );
        const resumed = await as("RECRUITER", () =>
          sessions.sessionControl("RESUME", {
            id: state.id,
            expectedVersion: paused.revision,
            reason: "Fixture resume",
          }),
        );
        assert.ok(
          resumed.section.remainingSeconds >=
            paused.section.remainingSeconds - 1,
        );
        const extended = await as("RECRUITER", () =>
          sessions.sessionControl("EXTEND", {
            id: state.id,
            expectedVersion: resumed.revision,
            extraTimePct: 20,
            reason: "Approved fixture accommodation",
          }),
        );
        assert.equal(
          +extended.section.deadlineAt - +resumed.section.deadlineAt,
          12000,
        );
        const next = await operate("NEXT_SECTION", {
          sectionKey: "copy",
          confirmed: true,
        });
        const row = await tx(
          async (db) =>
            (
              await db.$queryRawUnsafe(
                'SELECT * FROM "CandidateTestSessionSection" WHERE "sessionId"=$1 AND "sectionIndex"=1',
                state.id,
              )
            )[0],
        );
        assert.equal(+row.deadlineAt - +row.startedAt, 78000);
        assert.equal(next.section.key, "numbers");
        await operate("SUBMIT");
      },
    );
    await t.test(
      "interviewer reports include only served prompts, published probes and private cohort aggregates",
      async () => {
        const question = await as("RECRUITER", () =>
          forms.questionSave({
            question: {
              competencyKey: "copy",
              prompt: "Describe a copy-checking workflow.",
              followUps: ["How do you verify corrections?"],
              goodAnswerGuide: "Look for a repeatable verification process.",
              level: "INTERMEDIATE",
            },
          }),
        );
        await as("HR_HEAD", () =>
          forms.questionPublish({
            id: question.id,
            expectedVersion: question.revision,
          }),
        );
        await as("RECRUITER", () =>
          forms.questionSave({
            question: {
              competencyKey: "copy",
              prompt: "UNPUBLISHED PROBE",
              followUps: [],
              goodAnswerGuide: "Draft only",
              level: "INTERMEDIATE",
            },
          }),
        );
        const attempt = await timedSession();
        await attempt.operate("SUBMIT");
        const row = await tx((db) =>
          db.candidateTestResult.findUnique({
            where: { sessionId: attempt.state.id },
          }),
        );
        const report = await as("RECRUITER", () =>
          resultService.resultGet({ id: row.id }),
        );
        assert.equal(report.probes.length, 2);
        assert.equal(
          report.probes.find((p) => p.competencyKey === "copy").questions[0].id,
          question.id,
        );
        assert.equal(report.discussionPrompts.length, 1);
        assert.equal(report.timeTakenSec >= 0, true);
        const serialized = JSON.stringify(report);
        for (const secret of [
          "answerKey",
          "rationale",
          "optionOrder",
          "UNPUBLISHED PROBE",
        ])
          assert.equal(serialized.includes(secret), false);
        assert.equal(report.percentile, null);
        assert.equal(report.cohortSize < 5, true);
        const peer = await timedSession();
        await peer.operate("SUBMIT");
        const withCohort = await as("RECRUITER", () =>
          resultService.resultGet({ id: row.id }),
        );
        assert.equal(withCohort.cohortSize, 5);
        assert.equal(withCohort.percentile, 40);
        await assert.rejects(
          as("PANELIST", () => resultService.resultGet({ id: row.id })),
          /not found/,
        );
        await assert.rejects(
          as("INTERVIEWER", () =>
            resultService.resultGet({ id: row.id, interviewId: interview.id }),
          ),
          /not found/,
        );
      },
    );
    await t.test(
      "assessment monitoring enforces company and role boundaries and exposes aggregates only",
      async () => {
        const window = {
          from: new Date(Date.now() - 86400000).toISOString(),
          to: new Date(Date.now() + 86400000).toISOString(),
        };
        const report = await as("HR_HEAD", () =>
          resultService.testAnalytics(window),
        );
        assert.ok(report.total > 0);
        assert.ok(report.monitoring.items.length > 0);
        assert.equal(report.truncated, false);
        const forbidden = [
          "candidateId",
          "sessionId",
          "decisionReason",
          "answerKey",
          "email",
          "phone",
        ];
        for (const key of forbidden)
          assert.equal(JSON.stringify(report).includes(key), false);
        await assert.rejects(
          as("INTERVIEWER", () => resultService.testAnalytics(window)),
          /analytics access/,
        );
        await assert.rejects(
          as("HIRING_MANAGER", () => resultService.testAnalytics(window)),
          /analytics access/,
        );
        await assert.rejects(
          as("HR_HEAD", () =>
            resultService.testAnalytics({ from: window.to, to: window.from }),
          ),
          /positive range/,
        );
        const { assessmentAnalytics } =
          await import("../../src/services/candidate-assessment/analytics.js");
        const foreign = await tx(
          (db) => assessmentAnalytics(db, other, window),
          other,
        );
        assert.equal(foreign.total, 0);
        assert.deepEqual(foreign.monitoring.items, []);
      },
    );
    await t.test(
      "panelists cannot see peers before submission and amendments require reasons",
      async () => {
        const save = (role) =>
          as(role, () =>
            forms.formSave(
              {
                interviewId: interview.id,
                expectedVersion: 0,
                criterionScores: [
                  {
                    key: "accuracy",
                    rating: 3,
                    evidence: "Corrected the sample independently.",
                  },
                ],
                coiDeclared: true,
                recommendation: "HIRE",
                notes: "",
              },
              { submit: true },
            ),
          );
        await save("INTERVIEWER");
        const before = await as("PANELIST", () =>
          forms.formGet({ interviewId: interview.id }),
        );
        assert.equal(before.peersHidden, true);
        assert.deepEqual(before.peers, []);
        await save("PANELIST");
        const after = await as("PANELIST", () =>
          forms.formGet({ interviewId: interview.id }),
        );
        assert.equal(after.peers.length, 2);
        await assert.rejects(
          as("PANELIST", () =>
            forms.formSave(
              {
                interviewId: interview.id,
                expectedVersion: 1,
                criterionScores: [{ key: "accuracy", rating: 4, evidence: "" }],
                coiDeclared: true,
                recommendation: "HIRE",
                notes: "",
              },
              { submit: true },
            ),
          ),
          /amendment reason/,
        );
        const summary = await as("RECRUITER", () =>
          forms.summaryGet({ interviewId: interview.id }),
        );
        assert.equal(summary.testScorePct, 100);
        assert.equal(summary.interviewScorePct, 60);
        assert.equal(summary.compositeScore, 72);
      },
    );

    await t.test(
      "outcomes require a manager and freeze evaluation evidence",
      async () => {
        await assert.rejects(
          as("INTERVIEWER", () =>
            setInterviewOutcome({
              interviewId: interview.id,
              decision: "NEXT_ROUND",
              tenantId: tenant,
            }),
          ),
          /manager|recruiter/i,
        );
        await as("HIRING_MANAGER", () =>
          setInterviewOutcome({
            interviewId: interview.id,
            decision: "NEXT_ROUND",
            tenantId: tenant,
          }),
        );
        const report = await as("RECRUITER", () =>
          forms.summaryGet({ interviewId: interview.id }),
        );
        assert.equal(report.frozen, true);
        assert.equal(report.compositeScore, 72);
        await assert.rejects(
          tx((db) =>
            db.candidateEvaluationSummary.update({
              where: { id: report.id },
              data: { compositeScore: 99 },
            }),
          ),
          /immutable|frozen|HR-61/i,
        );
      },
    );
    await t.test(
      "assigned panelists see only completed earlier rounds of the same application",
      async () => {
        const next = await tx((db) =>
          db.interview.create({
            data: {
              tenantId: tenant,
              applicationId: application.id,
              interviewType: "FINAL",
              scheduledAt: new Date(+interview.scheduledAt + 86400000),
              formTemplateVersion: 1,
              formSnapshot: form,
              interviewers: {
                create: { tenantId: tenant, employeeId: staff.INTERVIEWER.id },
              },
            },
          }),
        );
        const context = await as("INTERVIEWER", () =>
          forms.formGet({ interviewId: next.id }),
        );
        assert.equal(context.earlierRounds.items.length, 1);
        assert.equal(context.earlierRounds.items[0].interviewId, interview.id);
        assert.equal(context.earlierRounds.items[0].summary.compositeScore, 72);
        assert.equal(context.peersHidden, true);
        assert.deepEqual(context.peers, []);
        const data = JSON.stringify(context.earlierRounds);
        for (const key of [
          "criterionScores",
          "reviewerId",
          "notes",
          "amendmentLog",
        ])
          assert.equal(data.includes(key), false);
        await assert.rejects(
          as("PANELIST", () => forms.formGet({ interviewId: next.id })),
          /not found/,
        );
      },
    );
    await t.test(
      "legacy feedback refuses reviewer impersonation and unassigned writers",
      async () => {
        const legacy = await tx((db) =>
          db.interview.create({
            data: {
              tenantId: tenant,
              applicationId: application.id,
              interviewType: "ONSITE",
              scheduledAt: new Date(),
              interviewers: {
                create: { tenantId: tenant, employeeId: staff.INTERVIEWER.id },
              },
            },
          }),
        );
        const data = {
          scores: { accuracy: 3 },
          recommendation: "HIRE",
          notes: "Observed work sample",
        };
        await assert.rejects(
          as("INTERVIEWER", () =>
            upsertInterviewScorecard({
              interviewId: legacy.id,
              reviewerId: staff.PANELIST.id,
              data,
              tenantId: tenant,
            }),
          ),
          /reviewer/i,
        );
        await assert.rejects(
          as("RECRUITER", () =>
            upsertInterviewScorecard({
              interviewId: legacy.id,
              reviewerId: staff.RECRUITER.id,
              data,
              tenantId: tenant,
            }),
          ),
          /not found/i,
        );
        const card = await as("INTERVIEWER", () =>
          upsertInterviewScorecard({
            interviewId: legacy.id,
            data,
            tenantId: tenant,
          }),
        );
        assert.equal(card.reviewerId, staff.INTERVIEWER.id);
        assert.equal(card.overallScore, 3);
      },
    );
  },
);
test.after(async () => prisma.$disconnect());
