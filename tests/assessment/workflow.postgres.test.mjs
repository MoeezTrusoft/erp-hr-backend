import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set ASSESSMENT_TEST_DATABASE_URL to a migrated disposable test database",
  );
const target = new URL(url);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/hr_task_assessment_test"
)
  throw new Error(
    "Only the isolated local hr_task_assessment_test database is permitted",
  );
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
const {completeBusinessApproval}=await import("../approval/complete.mjs");
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { administer } = await import("../../src/services/assessment/admin.js");
const { configure, createCatalog, transitionCatalog, qualify } =
  await import("../../src/services/assessment/catalog.js");
const { assign, saveObservation, workflow } =
  await import("../../src/services/assessment/workflow.js");
const { createManualCase, invalidateEvidence } =
  await import("../../src/services/assessment/evidence.js");
const { get, list } = await import("../../src/services/assessment/read.js");
const { manageEquivalence, equivalentCapabilities } =
  await import("../../src/services/assessment/equivalence.js");
const { exportAssessment } =
  await import("../../src/services/assessment/export.js");
const { identity, currentProfile } =
  await import("../../src/services/assessment/base.js");
const { draftNote } = await import("../../src/services/assessment/notes.js");
const { recordDraft } =
  await import("../../src/services/assessment/evidence.js");
const { publishDownstream } =
  await import("../../src/services/assessment/downstream.js");
const { acceptPmActual } =
  await import("../../src/services/assessment/source-stream.js");
const company = randomUUID(),
  other = randomUUID(),
  prefix = randomUUID().slice(0, 8).toUpperCase(),
  now = new Date(),
  future = new Date(+now + 180 * 86400000).toISOString();
const people = {},
  codes = ["SUBJECT", "RATER", "REVIEWER", "CREATOR", "OWNER", "HR"];
let position,
  task,
  profile,
  assignment,
  evidenceRef,
  appraisalCycle,
  finalizedReview;
const as = (code, fn, tenantId = company, permissions = null) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId,
        userId: people[code]?.userId,
        isAdmin: permissions === null,
      },
      permissions: permissions || [],
      servicePrincipal: "test",
    },
    fn,
  );
const db = (fn) =>
  mcpCtx.run({ user: { tenantId: company } }, () =>
    tenantTransaction(prisma, fn, { tenantId: company }),
  );
const declare =
  "I reviewed this exact revision and its evidence and confirm my recorded decision.";
test(
  "Complete assessment workflow and database invariants",
  { timeout: 60000 },
  async (t) => {
    await db(async (tx) => {
      position = await tx.position.create({
        data: { tenantId: company, title: `Test ${prefix}` },
      });
      for (let i = 0; i < codes.length; i++)
        people[codes[i]] = await tx.employee.create({
          data: {
            tenant_id: company,
            employee_code: `${prefix}-${codes[i]}`,
            employeeCategory: "EMPLOYEE",
            userId: 100000 + Math.floor(Math.random() * 100000000) + i,
            positionId: position.id,
            employement_status: "Active",
          },
        });
    });
    await as("HR", () => administer({ action: "VERIFY_IDENTITIES" }));
    await db(async (tx) => {
      appraisalCycle = await tx.performanceCycle.create({
        data: {
          tenantId: company,
          name: `Assessment cycle ${prefix}`,
          start_date: new Date(+now - 86400000),
          end_date: new Date(+now + 86400000),
        },
      });
      finalizedReview = await tx.performanceReview.create({
        data: {
          tenantId: company,
          employeeId: people.SUBJECT.id,
          cycleId: appraisalCycle.id,
          status: "DRAFT",
          overall_rating: 82,
        },
      });
    });
    await completeBusinessApproval(prisma,company,"PERFORMANCE",String(finalizedReview.id),{manager:people.RATER,hr:people.HR,management:people.OWNER});
    await as("HR",()=>administer({action:"VERIFY_IDENTITIES"}));
    await as("HR", () =>
      administer({
        action: "CATEGORY",
        categoryCode: "ENGINEERING",
        label: "Engineering",
      }),
    );
    const ownerCode = people.OWNER.employee_code;
    const rolloutEvidence = Object.fromEntries(
      ["identity", "sources", "pilotUat", "hrUat"].map((key) => [
        key,
        { reference: `test:${key}`, ownerCode, verifiedAt: now.toISOString() },
      ]),
    );
    await as("HR", () =>
      configure({
        expectedVersion: 0,
        policy: { stage: "FOUNDATION" },
        sourceRegister: [],
        departments: [
          {
            departmentRef: "IT",
            familyCodes: ["SOFTWARE"],
            ownerCode,
            confirmedActive: true,
          },
        ],
        learningMappings: [],
        rolloutEvidence,
      }),
    );
    const definition = {
      taskCode: `DEV-${prefix}`,
      taskVersion: 1,
      title: "Implement a verified API change",
      sectionCode: "IMPLEMENTATION",
      familyCode: "SOFTWARE",
      outcome: "Accepted change passes functional and security checks",
      scope: "ROUTINE_API",
      complexity: "ROUTINE",
      technology: "NODE",
      critical: false,
      applicability: { K: true, S: true, V: false },
      naReasons: { V: "TIMING_NOT_MEANINGFUL" },
      evidencePolicy: {
        methods: ["OBSERVED_WORK", "PRACTICAL_SIMULATION"],
        dimensions: ["K", "S"],
        minCases: 1,
        freshnessDays: 365,
        expiryDays: 365,
        retentionClass: "ASSESSMENT",
        acceptanceChecks: ["Test results and accepted change verified"],
      },
      ownerCode,
      guide:
        "Observe the employee’s own implementation and ask why controls were chosen.",
      practicalScenario:
        "Implement validation on a small API endpoint and demonstrate invalid input handling.",
      knowledgePrompts: [
        "Explain the validation and error-handling decisions.",
      ],
      workTypeMappings: [],
    };
    task = await as("CREATOR", () =>
      createCatalog({ kind: "TASK", definition }),
    );
    for (const [actor, action] of [
      ["CREATOR", "SUBMIT"],
      ["OWNER", "SME_APPROVE"],
      ["HR", "PUBLISH"],
    ])
      task = await as(actor, () =>
        transitionCatalog({
          kind: "TASK",
          ref: task.id,
          expectedVersion: task.version,
          action,
          declaration: declare,
        }),
      );
    profile = await as("CREATOR", () =>
      createCatalog({
        kind: "PROFILE",
        definition: {
          profileCode: `ROLE-${prefix}`,
          profileVersion: 1,
          title: "Software engineer",
          departmentRef: "IT",
          categoryCode: "ENGINEERING",
          positionRef: String(position.id),
          level: 2,
          ownerCode,
          requirements: [
            {
              taskCode: definition.taskCode,
              taskVersion: 1,
              requiredK: 3,
              requiredS: 3,
              targetV: null,
              prerequisites: [],
              supervisedAllowed: false,
              order: 1,
            },
          ],
          guide: "Complete only observed task-level results.",
        },
      }),
    );
    for (const [actor, action] of [
      ["CREATOR", "SUBMIT"],
      ["OWNER", "SME_APPROVE"],
      ["HR", "PUBLISH"],
    ])
      profile = await as(actor, () =>
        transitionCatalog({
          kind: "PROFILE",
          ref: profile.id,
          expectedVersion: profile.version,
          action,
          declaration: declare,
        }),
      );
    let reference = await as("CREATOR", () =>
      administer({
        action: "CREATE_CALIBRATION_REFERENCE",
        familyCode: "SOFTWARE",
        scopes: ["ROUTINE_API"],
        title: "API execution reference cases",
        expiresAt: future,
        items: [1, 2, 3].flatMap((n) =>
          ["K", "S"].map((d) => ({
            caseCode: `CASE-${n}`,
            taskCode: definition.taskCode,
            dimension: d,
            scenario:
              "Independent execution of an API validation change with all acceptance controls demonstrated.",
            expectedScore: 3,
          })),
        ),
        declaration: declare,
      }),
    );
    await assert.rejects(
      as("CREATOR", () =>
        administer({
          action: "APPROVE_CALIBRATION_REFERENCE",
          ref: reference.id,
          expectedSequence: reference.sequence,
          declaration: declare,
        }),
      ),
      (e) => e.code === "SELF_APPROVAL",
    );
    reference = await as("OWNER", () =>
      administer({
        action: "APPROVE_CALIBRATION_REFERENCE",
        ref: reference.id,
        expectedSequence: reference.sequence,
        declaration: declare,
      }),
    );
    const hidden = await as(
      "RATER",
      () => list({ view: "CALIBRATION" }),
      company,
      ["hr.assessment.self"],
    );
    assert.ok(
      hidden.items
        .find((i) => i.id === reference.id)
        .payload.items.every((i) => !Object.hasOwn(i, "expectedScore")),
    );
    for (const code of ["RATER", "REVIEWER"]) {
      const attempt = await as(code, () =>
        administer({
          action: "SUBMIT_CALIBRATION",
          ref: reference.id,
          answers: reference.payload.items.map((i) => ({
            caseCode: i.caseCode,
            dimension: i.dimension,
            score: 3,
            rationale: "Execution was independent with verified controls.",
          })),
          declaration: declare,
        }),
      );
      assert.equal(attempt.status, "PASSED");
      await as("HR", () =>
        qualify({
          employeeCode: people[code].employee_code,
          familyCode: "SOFTWARE",
          scopes: ["ROUTINE_API"],
          calibrationRef: attempt.id,
          expiresAt: future,
          expectedVersion: 0,
        }),
      );
    }
    await as("HR", () =>
      administer({
        action: "BIND_PROFILE",
        employeeCode: people.SUBJECT.employee_code,
        profileRef: profile.id,
        effectiveFrom: now.toISOString(),
        reason: "Verified position and assessment category",
      }),
    );
    for (const code of codes.filter((c) => c !== "SUBJECT"))
      await as("HR", () =>
        administer({
          action: "BIND_PROFILE",
          employeeCode: people[code].employee_code,
          profileRef: profile.id,
          effectiveFrom: now.toISOString(),
          reason: "Verified fixture role and category mapping",
        }),
      );
    await as("HR", () =>
      configure({
        expectedVersion: 1,
        policy: { stage: "HR_INTEGRATION", noteDraftFamilies: ["SOFTWARE"] },
        sourceRegister: [],
        departments: [
          {
            departmentRef: "IT",
            familyCodes: ["SOFTWARE"],
            ownerCode,
            confirmedActive: true,
          },
        ],
        learningMappings: [],
        rolloutEvidence,
      }),
    );
    const input = {
      employeeCode: people.SUBJECT.employee_code,
      profileRef: profile.id,
      purpose: "INITIAL",
      period: "2026-10",
      dueAt: future,
      raterCode: people.RATER.employee_code,
      reviewerCode: people.REVIEWER.employee_code,
      selectionReason: "Qualified independent assessment team",
      idempotencyKey: randomUUID(),
    };
    assignment = await as("HR", () => assign(input));
    await t.test(
      "Idempotent assignment; changed payload conflicts",
      async () => {
        assert.equal((await as("HR", () => assign(input))).id, assignment.id);
        await assert.rejects(
          as("HR", () => assign({ ...input, period: "2026-11" })),
          (e) => e.status === 409,
        );
      },
    );
    await t.test(
      "Employee sees blank ratings; foreign company cannot read",
      async () => {
        const fresh = await as(
          "SUBJECT",
          () => get({ assessmentRef: assignment.id }),
          company,
          ["hr.assessment.self"],
        );
        assert.equal(fresh.observations.length, 0);
        await assert.rejects(
          as("HR", () => get({ assessmentRef: assignment.id }), other),
          (e) => e.status === 403 || e.status === 404,
        );
      },
    );
    await t.test("DB-level cross-company read/write isolation", async () => {
      await db(async (tx) => {
        const rows =
          await tx.$queryRaw`SELECT id FROM "AssessmentAssignment" WHERE "tenantId"=${other}::uuid`;
        assert.equal(rows.length, 0);
      });
      await assert.rejects(
        db(
          (tx) =>
            tx.$executeRaw`INSERT INTO "AssessmentCategory" (id,"tenantId","categoryCode",label,active,version) VALUES (${randomUUID()}::uuid,${other}::uuid,'WRONG','Wrong company',true,1)`,
        ),
      );
    });
    const c = await as("RATER", () =>
      createManualCase({
        employeeCode: people.SUBJECT.employee_code,
        taskCodes: [definition.taskCode],
        title: "Observed API implementation",
        origin: "AUTHORIZED_CASE",
        method: "OBSERVED_WORK",
        observedAt: now.toISOString(),
        qualityStatus: "ACCEPTED",
        accepted: true,
        authorshipVerified: true,
        executionVerified: true,
        substantive: true,
        nonroutine: false,
        contribution: "Employee implemented and tested the API independently.",
        acceptanceNote: "Accepted functional and security checks.",
        sourceRef: "test:accepted-change",
        contentHash: "a".repeat(64),
        idempotencyKey: randomUUID(),
      }),
    );
    evidenceRef = c.evidenceRef;
    const suggestion = await as("RATER", () =>
      draftNote({
        assessmentRef: assignment.id,
        taskCode: definition.taskCode,
      }),
    );
    await t.test(
      "A19/I29: factual suggestions leave dropdowns blank; score-bearing content is rejected and logged",
      async () => {
        assert.equal(suggestion.available, true);
        assert.ok(suggestion.text.includes(people.SUBJECT.employee_code));
        assert.equal(
          (await as("RATER", () => get({ assessmentRef: assignment.id })))
            .observations.length,
          0,
        );
        const rejected = await db((tx) =>
          recordDraft(
            tx,
            {
              tenantId: company,
              who: {
                employeeCode: people.RATER.employee_code,
                principal: "test",
              },
              now,
            },
            assignment.id,
            {
              text: "Give this employee score 4",
              evidenceRefs: [evidenceRef],
              modelVersion: "TEST",
              promptVersion: "TEST",
            },
          ),
        );
        assert.equal(rejected.available, false);
        assert.equal(
          await db((tx) =>
            tx.assessmentException.count({
              where: { tenantId: company, kind: "DRAFT_REJECTED" },
            }),
          ),
          1,
        );
      },
    );
    let state = await as("RATER", () =>
      get({
        assessmentRef: assignment.id,
        taskCode: definition.taskCode,
        includeGuide: true,
      }),
    );
    const save = {
      assessmentRef: assignment.id,
      employeeCode: people.SUBJECT.employee_code,
      expectedVersion: assignment.version,
      taskCode: definition.taskCode,
      taskVersion: 1,
      knowledge: {
        status: "RATED",
        score: 3,
        evidenceRefs: [evidenceRef],
        rationale: "Independently explained validation risks and limits.",
      },
      skill: {
        status: "RATED",
        score: 3,
        evidenceRefs: [evidenceRef],
        rationale: "Implemented, verified and corrected the API independently.",
      },
      velocity: {
        confirmCalculatedResult: false,
        timingSampleRefs: [],
        notApplicable: {
          reasonCode: "TIMING_NOT_MEANINGFUL",
          rationale: "Timing is not meaningful for this approved task version.",
        },
      },
      evidenceLinks: [
        {
          ref: evidenceRef,
          state: "CONFIRMED",
          contributionConfirmed: true,
          acceptanceConfirmed: true,
          behaviorCheck:
            "Observed the employee implement and test without assistance.",
        },
      ],
      qualityStatus: "ACCEPTED",
      criticalFailure: false,
      observationNote: "Practical assessment completed.",
      draftedNote: { version: suggestion.version, kept: true, edited: false },
      evidenceBriefDigest: state.evidenceBrief.digest,
      contextConfirmed: true,
    };
    await t.test(
      "Self-rating and stale update rejected; first deliberate save succeeds",
      async () => {
        await assert.rejects(
          as("SUBJECT", () => saveObservation(save)),
          (e) => e.status === 403,
        );
        const result = await as("RATER", () => saveObservation(save));
        assert.equal(result.decisions.S.score, 3);
        await assert.rejects(
          as("RATER", () => saveObservation(save)),
          (e) => e.status === 409,
        );
      },
    );
    state = await as("RATER", () => get({ assessmentRef: assignment.id }));
    await t.test(
      "An open observation can be corrected without violating freeze guards",
      async () => {
        const result = await as("RATER", () =>
          saveObservation({
            ...save,
            expectedVersion: state.assignment.version,
            observationNote:
              "Verified after checking the practical result again.",
          }),
        );
        assert.equal(result.version, state.assignment.version + 1);
      },
    );
    state = await as("RATER", () => get({ assessmentRef: assignment.id }));
    assignment = await as("RATER", () =>
      workflow({
        assessmentRef: assignment.id,
        expectedVersion: state.assignment.version,
        action: "SUBMIT",
        declaration: declare,
      }),
    );
    state = await as("REVIEWER", () => get({ assessmentRef: assignment.id }));
    await t.test(
      "Manual evidence requires full review; signed observations are frozen",
      async () => {
        assert.equal(state.revision.reviewTier, "FULL");
        await assert.rejects(
          as("REVIEWER", () =>
            administer({
              action: "BATCH_APPROVE",
              items: [
                {
                  assessmentRef: assignment.id,
                  expectedVersion: assignment.version,
                  revisionDigest: state.revision.digest,
                },
              ],
              declaration: declare,
            }),
          ),
          (e) => e.code === "FULL_REVIEW_REQUIRED",
        );
        await assert.rejects(
          db(async (tx) => {
            const { id, ...o } = await tx.assessmentObservation.findFirst({
              where: { tenantId: company, assessmentRef: assignment.id },
            });
            return tx.assessmentObservation.create({
              data: { ...o, taskCode: "INSERT_AFTER_SUBMISSION" },
            });
          }),
          /cannot acquire new observation content/i,
        );
        await assert.rejects(
          db((tx) =>
            tx.assessmentDimension.updateMany({
              where: {
                tenantId: company,
                observationRef: state.observations[0].id,
              },
              data: { score: 4 },
            }),
          ),
        );
        await assert.rejects(
          as("RATER", () =>
            workflow({
              assessmentRef: assignment.id,
              expectedVersion: assignment.version,
              action: "APPROVE",
              declaration: declare,
              revisionDigest: state.revision.digest,
              reviewedTaskCodes: [definition.taskCode],
            }),
          ),
          (e) => e.status === 403,
        );
      },
    );
    assignment = await as("REVIEWER", () =>
      workflow({
        assessmentRef: assignment.id,
        expectedVersion: assignment.version,
        action: "APPROVE",
        declaration: declare,
        revisionDigest: state.revision.digest,
        reviewedTaskCodes: [definition.taskCode],
      }),
    );
    await t.test("Publication cannot bypass acknowledgment", () =>
      assert.rejects(
        as("HR", () =>
          workflow({
            assessmentRef: assignment.id,
            expectedVersion: assignment.version,
            action: "PUBLISH",
            declaration: declare,
            revisionDigest: state.revision.digest,
          }),
        ),
        (e) => e.code === "ACKNOWLEDGMENT_REQUIRED",
      ),
    );
    assignment = await as(
      "SUBJECT",
      () =>
        workflow({
          assessmentRef: assignment.id,
          expectedVersion: assignment.version,
          action: "ACKNOWLEDGE",
          declaration: "I acknowledge receipt; this does not imply agreement.",
          revisionDigest: state.revision.digest,
        }),
      company,
      ["hr.assessment.self"],
    );
    await completeBusinessApproval(prisma,company,"ASSESSMENT_RELEASE",`${assignment.id}@${assignment.revisionNo}`,{manager:people.RATER,hr:people.HR,management:people.OWNER});
    assignment = await as("HR", () =>
      workflow({
        assessmentRef: assignment.id,
        expectedVersion: assignment.version,
        action: "PUBLISH",
        declaration: declare,
        revisionDigest: state.revision.digest,
      }),
    );
    await t.test(
      "Publication creates capability and a transactional event without overall appraisal scoring",
      async () => {
        const rows = await db((tx) =>
          tx.assessmentCapability.findMany({
            where: {
              tenantId: company,
              employeeCode: people.SUBJECT.employee_code,
            },
          }),
        );
        assert.equal(rows.length, 3);
        assert.equal(rows.find((r) => r.dimension === "S").score, 3);
        const events = await db((tx) =>
          tx.outboxEvent.findMany({
            where: {
              tenantId: company,
              eventName: "hr.assessment.published.v1",
            },
          }),
        );
        assert.equal(events.length, 1);
        assert.equal(
          JSON.stringify(events[0].payload).includes("employeeId"),
          false,
        );
        const [input, oldReview] = await db(async (tx) => [
          await tx.assessmentAppraisalInput.findFirst({
            where: { tenantId: company, cycleId: appraisalCycle.id },
          }),
          await tx.performanceReview.findUnique({
            where: { id: finalizedReview.id },
          }),
        ]);
        assert.equal(input.amendment, true);
        assert.equal(
          input.content.tasks[0].dimensions.find((d) => d.dimension === "K")
            .required,
          3,
        );
        assert.equal(input.content.evidenceRecency.length, 1);
        assert.equal(
          input.content.selectionPolicy,
          "LATEST_APPLICABLE_APPROVED_OBSERVATION",
        );
        assert.equal(oldReview.status, "FINALIZED");
        assert.equal(oldReview.overall_rating, 82);
        await db(async (tx) => {
          const current = await tx.assessmentAssignment.findUnique({
            where: { id: assignment.id },
          });
          const rev = await tx.assessmentRevision.findFirst({
            where: {
              tenantId: company,
              assessmentRef: assignment.id,
              state: "PUBLISHED",
            },
          });
          await publishDownstream(
            tx,
            {
              tenantId: company,
              now: new Date(),
              who: { employeeCode: people.HR.employee_code, principal: "test" },
            },
            current,
            rev,
            rev.snapshot,
            rev.sequence,
          );
          assert.equal(
            await tx.assessmentAppraisalInput.count({
              where: { tenantId: company, cycleId: appraisalCycle.id },
            }),
            1,
          );
        });
      },
    );
    await t.test('development plans and JD publication require the full business approval chain',async()=>{
      const {decideIntegration,proposeJobDescription}=await import('../../src/services/assessment/downstream.js');
      const reviewers={manager:people.RATER,hr:people.HR,management:people.OWNER};
      const plan=await db(tx=>tx.assessmentIntegration.create({data:{tenantId:company,employeeCode:people.SUBJECT.employee_code,kind:'DEVELOPMENT',key:randomUUID(),sourceRef:assignment.id,status:'PROPOSED',payload:{taskCode:task.taskCode,dimension:'K',target:4,suggestedLearning:[]}}}));
      const command={ref:plan.id,expectedSequence:plan.sequence,action:'APPROVE_DEVELOPMENT',dueAt:future,declaration:declare};
      await assert.rejects(as('RATER',()=>decideIntegration(command)),/Complete the employee/);
      await completeBusinessApproval(prisma,company,'DEVELOPMENT',plan.id,reviewers);
      const approved=await as('RATER',()=>decideIntegration(command));assert.equal(approved.status,'APPROVED');assert.ok(approved.targetRef);
      let jd=await db(tx=>proposeJobDescription(tx,{tenantId:company},profile,people.SUBJECT.employee_code,'Fictional role update'));
      jd=await as('OWNER',()=>decideIntegration({ref:jd.id,expectedSequence:jd.sequence,action:'OWNER_APPROVE_JD',declaration:declare}));
      const publish={ref:jd.id,expectedSequence:jd.sequence,action:'PUBLISH_JD',declaration:declare};await assert.rejects(as('HR',()=>decideIntegration(publish)),/Complete the employee/);
      await completeBusinessApproval(prisma,company,'JOB_DESCRIPTION',jd.id,reviewers);
      const published=await as('HR',()=>decideIntegration(publish));assert.equal(published.status,'PUBLISHED');
    });
    await t.test(
      "Malformed PM code reconciliation cannot acknowledge an unrelated correction",
      async () => {
        await assert.rejects(
          acceptPmActual({
            id: randomUUID(),
            name: "pm.employee.code_reconciled.v1",
            tenantId: company,
            occurredAt: new Date().toISOString(),
            actor: { type: "service", id: "pm-assessment-outbox" },
            correlationId: randomUUID(),
            version: 1,
            payload: {},
          }),
        );
      },
    );
    await t.test(
      "Workforce forecast counts eligible employees and retains unconfirmed calendar status",
      async () => {
        const result = await as("HR", () =>
          list({ view: "FORECAST", pageSize: 100 }),
        );
        const row = result.items.find(
          (r) => r.taskCode === definition.taskCode && r.days === 0,
        );
        assert.ok(row);
        assert.equal(row.eligible, 1);
        assert.equal(row.calendarAvailable, 0);
        assert.ok(row.calendarUnconfirmed > 0);
        assert.equal(
          JSON.stringify(result.items).includes(people.SUBJECT.employee_code),
          false,
        );
      },
    );
    await t.test(
      "I20: explicit version equivalence requires owner proposal and separate HR approval",
      async () => {
        let next = await as("CREATOR", () =>
          createCatalog({
            kind: "TASK",
            definition: {
              ...definition,
              taskVersion: 2,
              title: "Implement and verify an API change",
            },
          }),
        );
        for (const [actor, action] of [
          ["CREATOR", "SUBMIT"],
          ["OWNER", "SME_APPROVE"],
          ["HR", "PUBLISH"],
        ])
          next = await as(actor, () =>
            transitionCatalog({
              kind: "TASK",
              ref: next.id,
              expectedVersion: next.version,
              action,
              declaration: declare,
            }),
          );
        const proposal = await as("OWNER", () =>
          manageEquivalence({
            action: "PROPOSE",
            taskCode: definition.taskCode,
            fromVersion: 1,
            toVersion: 2,
            dimensions: ["K", "S"],
            declaration:
              "The observable outcomes, controls and approved task scope remain equivalent.",
          }),
        );
        await assert.rejects(
          as("OWNER", () =>
            manageEquivalence({
              action: "APPROVE",
              ref: proposal.id,
              expectedSequence: proposal.sequence,
              declaration: declare,
            }),
          ),
          (e) => e.code === "SEPARATION_REQUIRED",
        );
        await as("HR", () =>
          manageEquivalence({
            action: "APPROVE",
            ref: proposal.id,
            expectedSequence: proposal.sequence,
            declaration: declare,
          }),
        );
        const caps = await db(async (tx) =>
          equivalentCapabilities(
            tx,
            company,
            await tx.assessmentCapability.findMany({
              where: {
                tenantId: company,
                employeeCode: people.SUBJECT.employee_code,
              },
            }),
          ),
        );
        assert.equal(caps.filter((c) => c.taskVersion === 2).length, 2);
        assert.ok(
          caps
            .filter((c) => c.taskVersion === 2)
            .every(
              (c) =>
                c.equivalenceRef === proposal.id && c.sourceTaskVersion === 1,
            ),
        );
      },
    );
    await t.test(
      "Approved exports retain signatures and code identity without internal actor IDs",
      async () => {
        const output = await as("HR", () =>
          exportAssessment({
            assessmentRef: assignment.id,
            revisionRef: state.revision.id,
          }),
        );
        assert.equal(output.employeeCode, people.SUBJECT.employee_code);
        assert.ok(output.signatures.length >= 4);
        assert.equal(JSON.stringify(output).includes("actorPrincipal"), false);
        await assert.rejects(
          as(
            "SUBJECT",
            () =>
              exportAssessment({
                assessmentRef: assignment.id,
                revisionRef: state.revision.id,
              }),
            company,
            ["hr.assessment.self"],
          ),
          (e) => e.status === 403,
        );
      },
    );
    await t.test(
      "All 415 source tasks import only as drafts and repeat imports are idempotent",
      async () => {
        let count = 0;
        for (const namespace of ["NET-ENG", "NET-OPS", "SW"]) {
          const result = await as("HR", () =>
            administer({
              action: "IMPORT_CATALOG_LIBRARY",
              namespace,
              ownerCode,
            }),
          );
          count += result.created;
          assert.equal(result.status, "DRAFT");
          assert.equal(
            (
              await as("HR", () =>
                administer({
                  action: "IMPORT_CATALOG_LIBRARY",
                  namespace,
                  ownerCode,
                }),
              )
            ).created,
            0,
          );
        }
        assert.equal(count, 415);
        assert.equal(
          await db((tx) =>
            tx.assessmentTaskVersion.count({
              where: { tenantId: company, status: "DRAFT" },
            }),
          ),
          415,
        );
      },
    );
    await t.test(
      "Source withdrawal raises a hold while immutable signed evidence remains intact",
      async () => {
        await db(async (tx) => {
          const e = await tx.assessmentEvidence.findFirst({
            where: { tenantId: company, id: evidenceRef },
          });
          await invalidateEvidence(
            tx,
            {
              tenantId: company,
              who: { principal: "test-source", employeeCode: null },
              now: new Date(),
            },
            [e],
            "REOPENED",
          );
        });
        const caps = await db((tx) =>
          tx.assessmentCapability.findMany({
            where: {
              tenantId: company,
              employeeCode: people.SUBJECT.employee_code,
            },
          }),
        );
        assert.ok(caps.every((c) => c.status === "HELD"));
        const rev = await db((tx) =>
          tx.assessmentRevision.findFirst({
            where: { tenantId: company, id: state.revision.id },
          }),
        );
        assert.equal(rev.digest, state.revision.digest);
      },
    );
    await t.test(
      "Database rejects audit edits and legacy code changes",
      async () => {
        const audit = await db((tx) =>
          tx.assessmentAudit.findFirst({ where: { tenantId: company } }),
        );
        await assert.rejects(
          db((tx) =>
            tx.assessmentAudit.update({
              where: { id: audit.id },
              data: { action: "FORGED" },
            }),
          ),
        );
        await assert.rejects(
          db((tx) =>
            tx.employee.update({
              where: { id: people.SUBJECT.id },
              data: { employee_code: "REUSED" },
            }),
          ),
        );
      },
    );
    await t.test(
      "I03: approved code correction preserves signed history and historical self-access",
      async () => {
        const oldCode = people.SUBJECT.employee_code,
          newCode = `${prefix}-CORRECTED`;
        await as("HR", () =>
          administer({
            action: "CORRECT_CODE",
            oldCode,
            newCode,
            reason:
              "Verified correction of the employee code by the data owner.",
          }),
        );
        const own = await as(
          "SUBJECT",
          () => get({ assessmentRef: assignment.id }),
          company,
          ["hr.assessment.self"],
        );
        assert.equal(own.assignment.employeeCode, oldCode);
        assert.equal(own.actorCode, newCode);
        assert.ok(own.actorCodes.includes(oldCode));
        await assert.rejects(
          as("HR", () =>
            administer({
              action: "CORRECT_CODE",
              oldCode: newCode,
              newCode: oldCode,
              reason: "Attempt to reuse the old employee code.",
            }),
          ),
        );
        people.SUBJECT.employee_code = newCode;
      },
    );
    await t.test(
      "I17: position changes require a matching profile even after identity reconciliation",
      async () => {
        const changed = await db((tx) =>
          tx.position.create({
            data: { tenantId: company, title: `New position ${prefix}` },
          }),
        );
        await db((tx) =>
          tx.employee.update({
            where: { id: people.SUBJECT.id },
            data: { positionId: changed.id },
          }),
        );
        await assert.rejects(
          db((tx) => identity(tx, company, people.SUBJECT.employee_code)),
          (e) => e.code === "IDENTITY_SCOPE_CHANGED",
        );
        await as("HR", () => administer({ action: "VERIFY_IDENTITIES" }));
        await assert.rejects(
          db(async (tx) =>
            currentProfile(
              tx,
              { tenantId: company, now: new Date() },
              await identity(tx, company, people.SUBJECT.employee_code),
            ),
          ),
          (e) => e.code === "PROFILE_SCOPE_CHANGED",
        );
        const history = await as("SUBJECT", () =>
          get({ assessmentRef: assignment.id }),
        );
        assert.equal(history.assignment.state, "PUBLISHED");
      },
    );
    await t.test(
      "Scheduled extract ingestion and opportunity withdrawal preserve tenant scope and replay safety",
      async () => {
        const { runSourceExtracts } =
          await import("../../src/services/assessment/source-extract.js");
        const { storeWorkOpportunity } =
          await import("../../src/services/assessment/development-matching.js");
        const env = {
          tenantId: company,
          now: new Date(),
          who: {
            principal: "assessment-test",
            employeeCode: people.HR.employee_code,
          },
        };
        const old = await db((tx) =>
          tx.assessmentConfiguration.findUnique({
            where: { tenantId: company },
          }),
        );
        await db((tx) =>
          tx.assessmentConfiguration.update({
            where: { tenantId: company },
            data: {
              policy: { ...old.policy, stage: "HR_INTEGRATION" },
              sourceRegister: [
                {
                  source: "ITSM",
                  enabled: true,
                  ownerCode: people.OWNER.employee_code,
                  extracts: [{ key: "TEST" }],
                },
              ],
            },
          }),
        );
        const e = {
          eventId: randomUUID(),
          companyUuid: company,
          source: "ITSM",
          sourceRecordId: "T-01",
          sourceVersion: 1,
          occurredAt: env.now.toISOString(),
          workType: "NETWORK",
          action: "ACCEPTED",
          contributors: [
            { employeeCode: people.RATER.employee_code, role: "EXECUTOR" },
          ],
          qualityStatus: "ACCEPTED",
          sourceRef: "itsm:T-01",
          contentHash: "b".repeat(64),
          classification: "INTERNAL",
          acceptanceVerified: true,
          executionVerified: true,
        };
        await runSourceExtracts(env, {
          db: prisma,
          transact: db,
          environment: {
            HR_ASSESSMENT_SOURCE_TEST_URL: "https://source.example",
            HR_ASSESSMENT_SOURCE_TEST_TOKEN: "fixture",
          },
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ items: [e], checkpoint: "checkpoint-1" }),
              { headers: { "content-type": "application/json" } },
            ),
        });
        const cursor = await db((tx) =>
          tx.assessmentIntegration.findFirst({
            where: { tenantId: company, kind: "SOURCE_CURSOR" },
          }),
        );
        assert.equal(cursor.payload.checkpoint, "checkpoint-1");
        assert.equal(
          await db((tx) =>
            tx.assessmentInboxEvent.count({
              where: { tenantId: company, eventId: e.eventId },
            }),
          ),
          1,
        );
        const o = {
          eventId: randomUUID(),
          companyUuid: company,
          source: "ITSM",
          sourceRecordId: "WORK-01",
          sourceVersion: 1,
          occurredAt: env.now.toISOString(),
          validUntil: new Date(+env.now + 600000).toISOString(),
          state: "AVAILABLE",
          ownerCode: people.OWNER.employee_code,
          requirements: [
            {
              taskCode: "TEST",
              taskVersion: 1,
              requiredK: 2,
              requiredS: 2,
              targetV: null,
              order: 0,
              prerequisites: [],
              supervisedAllowed: true,
              scopeKey: "NORMAL",
            },
          ],
          from: new Date(+env.now + 3600000).toISOString(),
          to: new Date(+env.now + 7200000).toISOString(),
          minutes: 60,
          risk: "LOW",
          complexity: "NORMAL",
          technology: "NODE",
          context: "NORMAL",
        };
        const first = await db((tx) => storeWorkOpportunity(tx, env, o));
        assert.equal(
          (await db((tx) => storeWorkOpportunity(tx, env, o))).duplicate,
          true,
        );
        await assert.rejects(
          db((tx) => storeWorkOpportunity(tx, env, { ...o, minutes: 61 })),
          (error) => error.code === "IDEMPOTENCY_CONFLICT",
        );
        await db((tx) =>
          storeWorkOpportunity(tx, env, {
            ...o,
            eventId: randomUUID(),
            sourceVersion: 2,
            state: "WITHDRAWN",
          }),
        );
        assert.equal(
          (await db((tx) => storeWorkOpportunity(tx, env, o))).ignored,
          "OLDER_VERSION",
        );
        assert.equal(
          (
            await db((tx) =>
              tx.assessmentIntegration.findFirst({
                where: { tenantId: company, id: first.opportunityRef },
              }),
            )
          ).status,
          "WITHDRAWN",
        );
        await assert.rejects(
          db((tx) =>
            storeWorkOpportunity(tx, env, { ...o, companyUuid: other }),
          ),
          (error) => error.code === "SOURCE_SCOPE",
        );
        await db((tx) =>
          tx.assessmentConfiguration.update({
            where: { tenantId: company },
            data: { policy: old.policy, sourceRegister: old.sourceRegister },
          }),
        );
      },
    );
    await t.test(
      "I17: offboarding immediately blocks new operations before the hourly registry refresh",
      async () => {
        await db((tx) =>
          tx.employee.update({
            where: { id: people.SUBJECT.id },
            data: { employement_status: "Inactive" },
          }),
        );
        await assert.rejects(
          db((tx) => identity(tx, company, people.SUBJECT.employee_code)),
          (e) => e.code === "IDENTITY_INACTIVE",
        );
        await assert.rejects(
          as("SUBJECT", () => get({ assessmentRef: assignment.id }), company, [
            "hr.assessment.self",
          ]),
          (e) => e.code === "ACTOR_INACTIVE",
        );
      },
    );
  },
);
test.after(async () => {
  await prisma.$disconnect();
});
