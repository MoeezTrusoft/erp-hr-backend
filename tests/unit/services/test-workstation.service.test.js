// Recruitment Phase 3b — kiosk workstations: the token is shown once and only
// its hash is stored; list never carries either; revoke and rotate stop the
// old token at once; verifyWorkstationToken looks the hash up under SYSTEM,
// compares in constant time, then reads under the workstation's tenant and
// accepts ACTIVE only.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { createHash } from "node:crypto";
import { createBlueprintDb } from "./helpers/test-blueprint.fake.js";

const { db, state, reset } = createBlueprintDb();
const logAction = jest.fn(async () => undefined);
const timingSafeEqual = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));
// The real crypto, with timingSafeEqual observed.
const realCrypto = await import("node:crypto");
jest.unstable_mockModule("node:crypto", () => ({
    ...realCrypto,
    default: realCrypto,
    timingSafeEqual: (a, b) => {
        timingSafeEqual(a, b);
        return realCrypto.timingSafeEqual(a, b);
    },
}));

const svc = await import("../../../src/services/test-workstation.service.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const admin = () => ({ tenantId: TENANT, access: resolveAssessmentAccess({ roles: ["HR_ADMIN"], employeeId: 8 }), actorId: 8 });
const recruiter = () => ({ tenantId: TENANT, access: resolveAssessmentAccess({ roles: ["RECRUITER"], employeeId: 7 }), actorId: 7 });
const inTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const sha = (t) => createHash("sha256").update(t).digest("hex");
const refusal = async (promise) => {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error("expected a refusal");
};

beforeEach(() => {
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
    reset();
    jest.clearAllMocks();
});
afterAll(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("admin tools", () => {
    it("register returns the token once and stores only its sha256", async () => {
        const out = await inTenant(() => svc.registerTestWorkstation({ ...admin(), label: " Desk 3 ", siteRef: "LHR-HQ" }));
        expect(out.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(out.workstation).toMatchObject({ label: "Desk 3", siteRef: "LHR-HQ", status: "ACTIVE", registeredById: 8 });
        expect(out.workstation).not.toHaveProperty("deviceTokenHash");
        expect(state.workstations[0].deviceTokenHash).toBe(sha(out.deviceToken));
        expect(JSON.stringify(state.workstations)).not.toContain(out.deviceToken);
        const list = await inTenant(() => svc.listTestWorkstations(admin()));
        expect(list.total).toBe(1);
        expect(JSON.stringify(list)).not.toMatch(/deviceToken|[0-9a-f]{64}/);
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, module: "Assessment Workstations" }));
    });

    it("only HR admins manage workstations, and only with the flag on", async () => {
        expect((await refusal(inTenant(() => svc.registerTestWorkstation({ ...recruiter(), label: "x", siteRef: "y" })))).status).toBe(403);
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        expect(await refusal(inTenant(() => svc.listTestWorkstations(admin())))).toMatchObject({ status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" });
    });

    it("revoke stops the token at once and records the reason in the audit log", async () => {
        const { workstation, deviceToken } = await inTenant(() => svc.registerTestWorkstation({ ...admin(), label: "Desk 1", siteRef: "LHR" }));
        expect(await svc.verifyWorkstationToken(deviceToken)).toMatchObject({ id: workstation.id, tenantId: TENANT });
        const out = await inTenant(() => svc.revokeTestWorkstation({ ...admin(), workstationId: workstation.id, reason: "Stolen keyboard" }));
        expect(out).toMatchObject({ revoked: true, workstation: { status: "REVOKED", revokedById: 8 } });
        expect(logAction).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.stringContaining("Stolen keyboard") }));
        expect(await svc.verifyWorkstationToken(deviceToken)).toBeNull();
        const again = await inTenant(() => svc.revokeTestWorkstation({ ...admin(), workstationId: workstation.id, reason: "again" }));
        expect(again.revoked).toBe(false);
        expect((await refusal(inTenant(() => svc.rotateTestWorkstationToken({ ...admin(), workstationId: workstation.id })))).code).toBe("HR-RECRUITMENT-WORKSTATION-REVOKED");
    });

    it("rotate issues a new token once; the old one stops matching", async () => {
        const first = await inTenant(() => svc.registerTestWorkstation({ ...admin(), label: "Desk 2", siteRef: "LHR" }));
        const rotated = await inTenant(() => svc.rotateTestWorkstationToken({ ...admin(), workstationId: first.workstation.id }));
        expect(rotated.deviceToken).not.toBe(first.deviceToken);
        expect(state.workstations[0].deviceTokenHash).toBe(sha(rotated.deviceToken));
        expect(await svc.verifyWorkstationToken(first.deviceToken)).toBeNull();
        expect(await svc.verifyWorkstationToken(rotated.deviceToken)).toMatchObject({ id: first.workstation.id });
    });

    it("another tenant's workstation is not found", async () => {
        const { workstation } = await inTenant(() => svc.registerTestWorkstation({ ...admin(), label: "Desk", siteRef: "LHR" }));
        const other = { ...admin(), tenantId: OTHER };
        expect((await refusal(inTenant(() => svc.revokeTestWorkstation({ ...other, workstationId: workstation.id, reason: "x" }), OTHER))).status).toBe(404);
        expect(state.workstations[0].status).toBe("ACTIVE");
    });
});

describe("verifyWorkstationToken", () => {
    it("looks up under SYSTEM, compares in constant time, then reads under the tenant", async () => {
        const { deviceToken } = await inTenant(() => svc.registerTestWorkstation({ ...admin(), label: "Desk", siteRef: "LHR" }));
        db.contextLog.length = 0;
        const ws = await svc.verifyWorkstationToken(deviceToken, { now: new Date("2026-10-20T09:00:00Z") });
        expect(ws).toEqual(expect.objectContaining({ tenantId: TENANT, label: "Desk", siteRef: "LHR", status: "ACTIVE" }));
        expect(ws).not.toHaveProperty("deviceTokenHash");
        expect(timingSafeEqual).toHaveBeenCalledTimes(1);
        expect(db.contextLog[0]).toMatchObject({ model: "testWorkstation", op: "findUnique", system: true });
        expect(db.contextLog.slice(1).every((c) => !c.system && c.tenantId === TENANT)).toBe(true);
        expect(state.workstations[0].lastSeenAt).toEqual(new Date("2026-10-20T09:00:00Z"));
    });

    it("an unknown token still costs one compare and answers null; malformed tokens never reach the DB", async () => {
        expect(await svc.verifyWorkstationToken("A".repeat(43))).toBeNull();
        expect(timingSafeEqual).toHaveBeenCalledTimes(1);
        db.contextLog.length = 0;
        for (const bad of [null, "", "short", "A".repeat(44), "!".repeat(43), 42]) expect(await svc.verifyWorkstationToken(bad)).toBeNull();
        expect(db.contextLog).toHaveLength(0);
    });

    it("answers null when the flag is off", async () => {
        const { deviceToken } = await inTenant(() => svc.registerTestWorkstation({ ...admin(), label: "Desk", siteRef: "LHR" }));
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        expect(await svc.verifyWorkstationToken(deviceToken)).toBeNull();
    });

    it("stamps lastSeenAt at most once a minute", async () => {
        const { deviceToken } = await inTenant(() => svc.registerTestWorkstation({ ...admin(), label: "Desk", siteRef: "LHR" }));
        await svc.verifyWorkstationToken(deviceToken, { now: new Date("2026-10-20T09:00:00Z") });
        await svc.verifyWorkstationToken(deviceToken, { now: new Date("2026-10-20T09:00:30Z") });
        expect(state.workstations[0].lastSeenAt).toEqual(new Date("2026-10-20T09:00:00Z"));
        await svc.verifyWorkstationToken(deviceToken, { now: new Date("2026-10-20T09:01:30Z") });
        expect(state.workstations[0].lastSeenAt).toEqual(new Date("2026-10-20T09:01:30Z"));
    });
});
