// tests/unit/services/talent-nurture.service.test.js
//
// Recruitment Phase 5 / plan 6.2 — talent pool nurture end to end against the
// in-memory client (lazy queries, tenant-filtered reads, rollback on throw):
//
//   * the nightly job proposes each requisition with a live posting exactly
//     once, segmenting the pool by skills and the role's city and leaving out
//     erased, do-not-contact, consent-withdrawn, already-applied and
//     already-invited people; a requisition with no skills still gets an
//     (empty) run so it is not rebuilt; a proposal whose requisition closed
//     expires; scans run as the system, each requisition under its tenant, and
//     one requisition's failure does not stop the others;
//   * the recruiter's send invites the approved members with a 30-day validity
//     and the run id, skips anyone blocked or no longer in the pool, and is
//     idempotent; a hiring manager cannot send; a failure sends nothing;
//   * an accepted nurture invitation becomes a TALENT_POOL application through
//     createApplication with an ADVANCE screening, BEFORE the invitation is
//     marked accepted.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { makeOnsiteDb, eventRecorder } from "./helpers/onsite-test.fake.js";

const db = makeOnsiteDb();
const recorder = eventRecorder();
const flags = { talentNurture: true };
const isRecruitmentFlagEnabled = jest.fn((key) => flags[key] === true);
const requisitionSkillRequirements = jest.fn((requisition) =>
    Array.isArray(requisition?.jobContent?.skills) ? { required: requisition.jobContent.skills, preferred: [] } : null,
);
const createApplication = jest.fn();
const recordScreening = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: recorder.enqueueHrDomainEvent,
    default: recorder.enqueueHrDomainEvent,
}));
jest.unstable_mockModule("../../../src/lib/recruitmentFlags.js", () => ({ isRecruitmentFlagEnabled }));
jest.unstable_mockModule("../../../src/services/candidateMatch.service.js", () => ({ requisitionSkillRequirements }));
jest.unstable_mockModule("../../../src/services/applicationService.js", () => ({ createApplication }));
jest.unstable_mockModule("../../../src/services/applicationScreening.service.js", () => ({ recordScreening }));

const {
    TALENT_NURTURE_PROPOSED_EVENT,
    dismissNurtureRun,
    getNurtureRun,
    intakeAcceptedNurtureInvitation,
    listNurtureRuns,
    runTalentNurtureProposalJob,
    sendNurtureRun,
} = await import("../../../src/services/talent-nurture.service.js");
const { respondToInvitation } = await import("../../../src/services/talentPoolInvitation.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T02:00:00.000Z");
const RECRUITER = resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: 7 });
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 8 });
const OTHER_MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 99 });

const asTenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const t = () => db.state.tables;
const run = (id) => t().talentPoolNurtureRun.find((r) => r.id === id);
const minutesBefore = (m) => new Date(NOW.getTime() - m * 60_000);

const candidate = (id, tenantId, location, extra = {}) => ({
    id, tenantId, firstName: `C${id}`, lastName: "Pool", email: `c${id}@example.test`, location,
    source: "LinkedIn", parsedResume: { yearsOfExperience: 4 }, anonymizedAt: null, consentStatus: "GRANTED", ...extra,
});

function seed() {
    db.state.tables = {};
    db.state.ops.length = 0;
    recorder.events.length = 0;
    const tables = db.state.tables;
    tables.jobRequisition = [
        { id: 10, tenantId: A, title: "Backend engineer", status: "POSTED", closesAt: null, location: "Lahore, Pakistan", jobContent: { skills: ["Node.js"] }, requirements: null, recruiterId: 7, requestedById: 8, approvedById: null },
        { id: 11, tenantId: A, title: "Generalist", status: "POSTED", closesAt: null, location: "Lahore", jobContent: null, requirements: null, recruiterId: 7, requestedById: 5, approvedById: null },
        { id: 12, tenantId: B, title: "Go engineer", status: "POSTED", closesAt: null, location: "Remote", jobContent: { skills: ["Go"] }, requirements: null, recruiterId: null, requestedById: 5, approvedById: null },
        { id: 13, tenantId: A, title: "Closed role", status: "CLOSED", closesAt: null, location: "Lahore", jobContent: { skills: ["Node.js"] }, requirements: null, recruiterId: 7, requestedById: 5, approvedById: null },
        { id: 14, tenantId: A, title: "Already sent", status: "POSTED", closesAt: null, location: "Lahore", jobContent: { skills: ["Node.js"] }, requirements: null, recruiterId: 7, requestedById: 5, approvedById: null },
    ];
    tables.jobPosting = [
        { id: 1, tenantId: A, requisitionId: 10, isActive: true, closedAt: null, channel: "CAREER_SITE", postedAt: minutesBefore(60) },
        { id: 2, tenantId: A, requisitionId: 11, isActive: true, closedAt: null, channel: "CAREER_SITE", postedAt: minutesBefore(50) },
        { id: 3, tenantId: B, requisitionId: 12, isActive: true, closedAt: null, channel: "CAREER_SITE", postedAt: minutesBefore(40) },
        { id: 4, tenantId: A, requisitionId: 13, isActive: false, closedAt: minutesBefore(30), channel: "CAREER_SITE", postedAt: minutesBefore(900) },
        { id: 5, tenantId: A, requisitionId: 14, isActive: true, closedAt: null, channel: "CAREER_SITE", postedAt: minutesBefore(20) },
        { id: 6, tenantId: A, requisitionId: 10, isActive: true, closedAt: null, channel: "LINKEDIN", postedAt: minutesBefore(10) },
    ];
    tables.candidate = [
        candidate(1, A, "Lahore"),
        candidate(2, A, "Karachi"),
        candidate(3, A, "Lahore", { anonymizedAt: minutesBefore(5000), firstName: "Erased" }),
        candidate(4, A, "Lahore Cantt"),
        candidate(5, A, "Lahore"),
        candidate(6, A, "Lahore"),
        candidate(7, A, "Lahore"),
        candidate(8, A, "Lahore"),
        candidate(9, A, "Lahore", { consentStatus: "WITHDRAWN" }),
        candidate(20, B, "Berlin"),
    ];
    tables.candidateSkill = [1, 2, 3, 4, 5, 6, 7, 9].map((id) => ({ id: 100 + id, tenantId: A, candidateId: id, name: "node.js" }));
    tables.candidateSkill.push({ id: 108, tenantId: A, candidateId: 8, name: "Java" }, { id: 120, tenantId: B, candidateId: 20, name: "Go" });
    tables.talentPool = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({ id: 200 + id, tenantId: A, candidateId: id, poolName: "Engineering", addedAt: minutesBefore(1000 - id) }));
    tables.talentPool.push({ id: 220, tenantId: B, candidateId: 20, poolName: "Go", addedAt: minutesBefore(100) });
    tables.candidateDncEntry = [{ id: 300, tenantId: A, email: "c4@example.test", status: "ACTIVE", expiresAt: null, reasonCode: "REQUESTED", effectiveFrom: minutesBefore(9000) }];
    tables.candidateConsent = [
        { id: 400, tenantId: A, candidateId: 5, purpose: "TALENT_POOL", status: "GRANTED", occurredAt: minutesBefore(9000) },
        { id: 401, tenantId: A, candidateId: 5, purpose: "TALENT_POOL", status: "WITHDRAWN", occurredAt: minutesBefore(100) },
    ];
    tables.application = [{ id: 500, tenantId: A, candidateId: 6, jobRequisitionId: 10, stage: "screening" }];
    tables.talentPoolInvitation = [{ id: 600, tenantId: A, candidateId: 7, jobRequisitionId: 10, status: "INVITED", invitedAt: minutesBefore(100), expiresAt: new Date("2099-01-01T00:00:00Z") }];
    tables.talentPoolNurtureRun = [
        { id: 900, tenantId: A, requisitionId: 13, status: "PROPOSED", candidateIds: [1], proposedCount: 1, invitedCount: 0, validityDays: 30 },
        { id: 901, tenantId: A, requisitionId: 14, status: "SENT", candidateIds: [1], proposedCount: 1, invitedCount: 1, validityDays: 30 },
    ];
}

beforeEach(() => {
    jest.clearAllMocks();
    flags.talentNurture = true;
    flags.workflow = true;
    seed();
});

describe("runTalentNurtureProposalJob", () => {
    it("does nothing with the flag off", async () => {
        flags.talentNurture = false;
        expect(await runTalentNurtureProposalJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(db.state.ops).toHaveLength(0);
    });

    it("proposes each posted requisition once, segmented and with the privacy exclusions", async () => {
        const summary = await runTalentNurtureProposalJob({ now: NOW });
        expect(summary).toEqual({ scanned: 3, proposed: 2, empty: 1, skipped: 0, raceLost: 0, expired: 1, errors: 0 });

        const backend = t().talentPoolNurtureRun.find((r) => r.requisitionId === 10);
        expect(backend).toMatchObject({ tenantId: A, status: "PROPOSED", candidateIds: [1], proposedCount: 1, validityDays: 30 });
        expect(backend.criteria).toMatchObject({
            skills: ["Node.js"],
            locations: ["Lahore"],
            poolCandidates: 9,
            matchedTotal: 1,
            truncated: false,
            excludedByReason: { location: 1, anonymized: 1, dnc: 1, consent_withdrawn: 2, applied: 1, invited: 1, skills: 1 },
        });
        // A remote role in another tenant segments on skills only, in its tenant.
        expect(t().talentPoolNurtureRun.find((r) => r.requisitionId === 12)).toMatchObject({ tenantId: B, candidateIds: [20], proposedCount: 1 });
        // No skills: an empty run so the job does not rebuild it.
        expect(t().talentPoolNurtureRun.find((r) => r.requisitionId === 11)).toMatchObject({
            status: "PROPOSED", candidateIds: [], proposedCount: 0, criteria: expect.objectContaining({ noSegment: "NO_SKILLS" }),
        });
        // The closed requisition's proposal lapsed; the sent one is untouched.
        expect(run(900).status).toBe("EXPIRED");
        expect(run(901).status).toBe("SENT");
    });

    it("tells the requisition's recruiter about a non-empty proposal, ids only", async () => {
        await runTalentNurtureProposalJob({ now: NOW });
        const events = recorder.named("talent_nurture_proposed");
        expect(events).toHaveLength(2);
        const backend = t().talentPoolNurtureRun.find((r) => r.requisitionId === 10);
        expect(events.find((e) => e.tenantId === A)).toEqual(expect.objectContaining({
            eventName: TALENT_NURTURE_PROPOSED_EVENT,
            aggregateType: "TalentPoolNurtureRun",
            aggregateId: backend.id,
            payload: { runId: String(backend.id), requisitionId: "10", proposedCount: 1, recruiterId: "7" },
        }));
        expect(events.find((e) => e.tenantId === B).payload.recruiterId).toBeNull();
    });

    it("scans as the system and works each requisition under its own tenant", async () => {
        await runTalentNurtureProposalJob({ now: NOW });
        const creates = db.state.ops.filter((op) => op.model === "talentPoolNurtureRun" && op.op === "create");
        expect(creates.map((op) => op.tenant).sort()).toEqual([A, A, B].sort());
        expect(creates.every((op) => op.tx != null)).toBe(true);
        const poolReads = db.state.ops.filter((op) => op.model === "talentPool");
        expect(poolReads.every((op) => op.tenant !== "SYSTEM")).toBe(true);
        expect(db.state.ops.filter((op) => op.model === "jobPosting" && op.tenant === "SYSTEM")).toHaveLength(1);
    });

    it("is idempotent: a second pass proposes nothing new", async () => {
        await runTalentNurtureProposalJob({ now: NOW });
        const count = t().talentPoolNurtureRun.length;
        recorder.events.length = 0;
        const summary = await runTalentNurtureProposalJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 0, proposed: 0, expired: 0 });
        expect(t().talentPoolNurtureRun).toHaveLength(count);
        expect(recorder.events).toHaveLength(0);
    });

    it("isolates one requisition's failure", async () => {
        requisitionSkillRequirements.mockImplementationOnce(() => {
            throw new Error("boom");
        });
        const summary = await runTalentNurtureProposalJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 3, errors: 1 });
        expect(summary.proposed + summary.empty).toBe(2);
        // The failed requisition rolled back and is retried next pass.
        expect(t().talentPoolNurtureRun.find((r) => r.requisitionId === 10)).toBeUndefined();
        expect((await runTalentNurtureProposalJob({ now: NOW })).proposed).toBe(1);
    });
});

describe("sendNurtureRun", () => {
    const proposal = (over = {}) => {
        t().talentPoolNurtureRun.push({
            id: 950, tenantId: A, requisitionId: 10, status: "PROPOSED", candidateIds: [1, 8, 4, 32],
            proposedCount: 4, invitedCount: 0, validityDays: 30, criteria: { skills: ["Node.js"] }, ...over,
        });
    };
    const send = (args = {}, scope = RECRUITER) =>
        asTenant(A, () => sendNurtureRun({ tenantId: A, scope, runId: 950, actorId: 7, ...args }));

    it("invites the approved members for 30 days, stamps the run and announces each invitation", async () => {
        proposal();
        const result = await send({ dropCandidateIds: [8] });
        expect(result).toMatchObject({
            alreadySent: false,
            invitedCount: 1,
            dropped: [8],
            // Do-not-contact since the proposal, and no longer in any pool.
            skipped: [
                { candidateId: 4, code: "HR-RECRUITMENT-DNC-BLOCKED" },
                { candidateId: 32, code: "HR-RECRUITMENT-NURTURE-NOT-IN-POOL" },
            ],
            ignoredDropIds: [],
        });
        const invitation = t().talentPoolInvitation.find((i) => i.nurtureRunId === 950);
        expect(invitation).toMatchObject({ tenantId: A, candidateId: 1, jobRequisitionId: 10, status: "INVITED", invitedById: 7 });
        expect(Math.round((invitation.expiresAt - invitation.invitedAt) / 86_400_000)).toBe(30);
        expect(result.invitationIds).toEqual([invitation.id]);
        expect(run(950)).toMatchObject({ status: "SENT", decidedById: 7, invitedCount: 1, candidateIds: [1, 4, 32], proposedCount: 4 });
        expect(run(950).decidedAt).toBeInstanceOf(Date);
        const sent = recorder.named("talent_pool_invitation_sent");
        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toMatchObject({ invitationId: String(invitation.id), candidateId: "1", jobRequisitionId: "10", reused: false });
    });

    it("is idempotent on a second call", async () => {
        proposal();
        const first = await send();
        recorder.events.length = 0;
        const invitations = t().talentPoolInvitation.length;
        const second = await send({ dropCandidateIds: [1] });
        expect(second).toMatchObject({ alreadySent: true, invitedCount: first.invitedCount, invitationIds: first.invitationIds });
        expect(t().talentPoolInvitation).toHaveLength(invitations);
        expect(recorder.events).toHaveLength(0);
    });

    it("honours a custom validity", async () => {
        proposal({ candidateIds: [1] });
        await send({ validityDays: 14 });
        const invitation = t().talentPoolInvitation.find((i) => i.nurtureRunId === 950);
        expect(Math.round((invitation.expiresAt - invitation.invitedAt) / 86_400_000)).toBe(14);
        expect(run(950).validityDays).toBe(14);
    });

    it("refuses a hiring manager and writes nothing", async () => {
        proposal();
        await expect(send({}, MANAGER)).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-NURTURE-FORBIDDEN" });
        expect(run(950).status).toBe("PROPOSED");
        expect(db.state.ops.filter((op) => op.model === "talentPoolNurtureRun")).toHaveLength(0);
    });

    it("refuses when the requisition stopped accepting applications", async () => {
        proposal();
        t().jobRequisition.find((r) => r.id === 10).status = "WITHDRAWN";
        await expect(send()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-NURTURE-REQUISITION-CLOSED" });
        expect(run(950).status).toBe("PROPOSED");
    });

    it("refuses when every member was dropped", async () => {
        proposal({ candidateIds: [1] });
        await expect(send({ dropCandidateIds: [1] })).rejects.toMatchObject({ status: 422, code: "HR-RECRUITMENT-NURTURE-EMPTY" });
    });

    it("refuses a decided run and a run in another tenant", async () => {
        proposal({ status: "DISMISSED" });
        await expect(send()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-NURTURE-TRANSITION-INVALID" });
        await expect(asTenant(B, () => sendNurtureRun({ tenantId: B, scope: RECRUITER, runId: 950 })))
            .rejects.toMatchObject({ status: 404 });
    });

    it("sends nothing when an invitation write fails", async () => {
        proposal({ candidateIds: [1, 8] });
        const create = db.talentPoolInvitation.create;
        let calls = 0;
        db.talentPoolInvitation.create = (args) => {
            calls += 1;
            if (calls === 2) return Promise.reject(Object.assign(new Error("connection reset"), { code: "P1017" }));
            return create(args);
        };
        try {
            await expect(send()).rejects.toMatchObject({ code: "P1017" });
        } finally {
            db.talentPoolInvitation.create = create;
        }
        expect(run(950).status).toBe("PROPOSED");
        expect(t().talentPoolInvitation.filter((i) => i.nurtureRunId === 950)).toHaveLength(0);
    });

    it("answers 503 with the flag off", async () => {
        proposal();
        flags.talentNurture = false;
        await expect(send()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-TALENT-NURTURE-DISABLED" });
    });
});

describe("dismissNurtureRun", () => {
    it("dismisses a proposal with the reason, once", async () => {
        const dismiss = (reason) => asTenant(A, () => dismissNurtureRun({ tenantId: A, scope: RECRUITER, runId: 900, reason, actorId: 7 }));
        await expect(dismiss("  ")).rejects.toMatchObject({ code: "HR-RECRUITMENT-NURTURE-REASON-REQUIRED" });
        const result = await dismiss("Hiring paused");
        expect(result).toMatchObject({ alreadyDismissed: false, run: { status: "DISMISSED", dismissedReason: "Hiring paused", decidedById: 7 } });
        expect((await dismiss("again")).alreadyDismissed).toBe(true);
        expect(run(900).dismissedReason).toBe("Hiring paused");
    });

    it("cannot dismiss a sent run, and a manager cannot dismiss at all", async () => {
        await expect(asTenant(A, () => dismissNurtureRun({ tenantId: A, scope: RECRUITER, runId: 901, reason: "x" })))
            .rejects.toMatchObject({ status: 409 });
        await expect(asTenant(A, () => dismissNurtureRun({ tenantId: A, scope: MANAGER, runId: 900, reason: "x" })))
            .rejects.toMatchObject({ status: 403 });
    });
});

describe("reading runs", () => {
    beforeEach(() => {
        t().talentPoolNurtureRun.push({ id: 950, tenantId: A, requisitionId: 10, status: "PROPOSED", candidateIds: [1, 3], proposedCount: 2, invitedCount: 0, validityDays: 30, criteria: { skills: ["Node.js"] }, createdAt: NOW });
    });

    it("lists the tenant's runs for a recruiter and only their own requisitions' for a manager", async () => {
        const all = await asTenant(A, () => listNurtureRuns({ tenantId: A, scope: RECRUITER }));
        expect(all.total).toBe(3);
        expect(all.items.find((r) => r.id === 950)).toMatchObject({ requisition: { id: 10, title: "Backend engineer" }, memberCount: 2 });
        expect(all.items[0]).not.toHaveProperty("candidateIds");

        const mine = await asTenant(A, () => listNurtureRuns({ tenantId: A, scope: MANAGER }));
        expect(mine.items.map((r) => r.id)).toEqual([950]);
        expect((await asTenant(A, () => listNurtureRuns({ tenantId: A, scope: OTHER_MANAGER }))).total).toBe(0);
        expect((await asTenant(A, () => listNurtureRuns({ tenantId: A, scope: RECRUITER, status: "SENT" }))).items.map((r) => r.id)).toEqual([901]);
    });

    it("shows each member's pool display data, never contact data", async () => {
        const result = await asTenant(A, () => getNurtureRun({ tenantId: A, scope: MANAGER, runId: 950 }));
        expect(result.members).toEqual([
            {
                candidateId: 1, name: "C1 Pool", location: "Lahore", experienceYears: 4, skills: ["node.js"],
                pools: ["Engineering"], inPool: true, source: "LinkedIn", invitation: null, applicationId: null,
            },
            { candidateId: 3, anonymized: true, invitation: null, applicationId: null },
        ]);
        expect(JSON.stringify(result)).not.toContain("@example.test");
    });

    it("reads an out-of-scope run as not found", async () => {
        await expect(asTenant(A, () => getNurtureRun({ tenantId: A, scope: OTHER_MANAGER, runId: 950 })))
            .rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-NURTURE-RUN-NOT-FOUND" });
    });
});

describe("accepting a nurture invitation", () => {
    beforeEach(() => {
        t().talentPoolNurtureRun.push({ id: 950, tenantId: A, requisitionId: 10, status: "SENT", candidateIds: [1], proposedCount: 1, invitedCount: 1, validityDays: 30, decidedById: 7 });
        t().talentPoolInvitation.push({ id: 700, tenantId: A, candidateId: 1, jobRequisitionId: 10, status: "INVITED", invitedAt: minutesBefore(60), expiresAt: new Date("2099-01-01T00:00:00Z"), nurtureRunId: 950, responseNote: null });
        createApplication.mockImplementation(async (args) => ({ id: 800, candidateId: args.candidateId, jobRequisitionId: args.jobRequisitionId }));
        recordScreening.mockResolvedValue({ id: 1 });
    });
    const accept = () => asTenant(A, () => respondToInvitation({ tenantId: A, invitationId: 700, response: "ACCEPTED" }));
    const invitation = () => t().talentPoolInvitation.find((i) => i.id === 700);

    it("creates a pre-screened TALENT_POOL application through the gated intake", async () => {
        const result = await accept();
        expect(createApplication).toHaveBeenCalledWith({
            candidateId: 1, jobRequisitionId: 10, tenantId: A, createdById: 7,
            source: "talent-pool", sourceChannel: "TALENT_POOL", sourceDetail: "nurture:950",
        });
        expect(recordScreening).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 800, tenantId: A, outcome: "ADVANCE", actorId: 7 }));
        expect(result).toMatchObject({ status: "ACCEPTED", application: { applicationId: 800, created: true, preScreened: true } });
        expect(invitation().status).toBe("ACCEPTED");
    });

    it("leaves the invitation open when the intake refuses", async () => {
        createApplication.mockRejectedValue(Object.assign(new Error("closed"), { status: 409, code: "HR-RECRUITMENT-APPLICATIONS-CLOSED" }));
        await expect(accept()).rejects.toMatchObject({ code: "HR-RECRUITMENT-APPLICATIONS-CLOSED" });
        expect(invitation().status).toBe("INVITED");
    });

    it("reuses an existing application and keeps a failed pre-screen soft", async () => {
        t().application.push({ id: 801, tenantId: A, candidateId: 1, jobRequisitionId: 10 });
        expect(await asTenant(A, () => intakeAcceptedNurtureInvitation({ tenantId: A, invitation: invitation() })))
            .toEqual({ applicationId: 801, created: false, preScreened: false });
        expect(createApplication).not.toHaveBeenCalled();

        t().application.pop();
        recordScreening.mockRejectedValue(new Error("template mismatch"));
        expect(await asTenant(A, () => intakeAcceptedNurtureInvitation({ tenantId: A, invitation: invitation() })))
            .toEqual({ applicationId: 800, created: true, preScreened: false });
    });

    it("changes nothing for other invitations or with the flag off", async () => {
        expect(await asTenant(A, () => intakeAcceptedNurtureInvitation({ tenantId: A, invitation: { ...invitation(), nurtureRunId: null } }))).toBeNull();
        flags.talentNurture = false;
        const result = await accept();
        expect(result.status).toBe("ACCEPTED");
        expect(result).not.toHaveProperty("application");
        expect(createApplication).not.toHaveBeenCalled();
    });
});
