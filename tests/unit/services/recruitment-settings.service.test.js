// Phase 2 tenant recruitment settings: defaults, validation, the version guard
// and the feed token lifecycle (issued on enable and on rotate, never on a
// plain read).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const tx = {
    $executeRaw: jest.fn(async () => 1),
    tenantRecruitmentSettings: { findUnique: jest.fn(), upsert: jest.fn() },
};
const db = {
    $transaction: jest.fn(async (fn) => fn(tx)),
    tenantRecruitmentSettings: { findUnique: jest.fn() },
};

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const {
    defaultRecruitmentSettings,
    getRecruitmentSettings,
    normalizeRecruitmentSettingsInput,
    updateRecruitmentSettings,
} = await import("../../../src/services/recruitment-settings.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";

const ROW = {
    tenantId: TENANT,
    defaultChannels: ["CAREER_SITE"],
    rejectionDelayHours: 48,
    knockoutDelayHours: 24,
    shortlistThreshold: 70,
    shortlistTopPercent: 10,
    feedEnabled: true,
    feedToken: "existing-token-existing-token-xx",
    companyName: "Acme",
    companyUrl: null,
    companyLogoUrl: null,
    portalBaseUrl: "https://careers.acme.test/",
    version: 3,
    updatedById: 5,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T00:00:00Z"),
};

// The upsert echoes back what it would store.
const echoUpsert = (latest) => async ({ create, update }) => {
    if (!latest) return { ...defaultRecruitmentSettings(TENANT), feedToken: null, ...create };
    const { version: _v, ...changes } = update;
    return { ...latest, ...changes, version: latest.version + 1 };
};

beforeEach(() => {
    jest.clearAllMocks();
    tx.tenantRecruitmentSettings.findUnique.mockResolvedValue(null);
    tx.tenantRecruitmentSettings.upsert.mockImplementation(echoUpsert(null));
});

describe("getRecruitmentSettings", () => {
    it("returns the defaults with id null and version 0 when the tenant never saved", async () => {
        db.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce(null);
        const settings = await getRecruitmentSettings({ tenantId: TENANT });
        expect(settings).toMatchObject({
            id: null,
            tenantId: TENANT,
            rejectionDelayHours: 48,
            knockoutDelayHours: 24,
            shortlistThreshold: 70,
            shortlistTopPercent: 10,
            feedEnabled: false,
            defaultChannels: [],
            portalBaseUrl: null,
            hasFeedToken: false,
            version: 0,
        });
        expect(db.tenantRecruitmentSettings.findUnique).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
    });

    it("never returns the feed token on a plain read", async () => {
        db.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce({ ...ROW });
        const settings = await getRecruitmentSettings({ tenantId: TENANT });
        expect(settings).not.toHaveProperty("feedToken");
        expect(settings.hasFeedToken).toBe(true);
        expect(JSON.stringify(settings)).not.toContain(ROW.feedToken);
    });

    it("returns the token only when asked", async () => {
        db.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce({ ...ROW });
        const settings = await getRecruitmentSettings({ tenantId: TENANT, includeFeedToken: true });
        expect(settings.feedToken).toBe(ROW.feedToken);
    });

    it("requires a tenant", async () => {
        await expect(getRecruitmentSettings({})).rejects.toMatchObject({ status: 403, code: "HR-TENANT-REQUIRED" });
    });
});

describe("normalizeRecruitmentSettingsInput", () => {
    it.each([
        ["rejectionDelayHours", -1],
        ["rejectionDelayHours", 721],
        ["knockoutDelayHours", 1.5],
        ["shortlistThreshold", 101],
        ["shortlistTopPercent", "abc"],
        ["rejectionDelayHours", null],
        ["knockoutDelayHours", ""],
        ["shortlistThreshold", true],
    ])("rejects %s = %p", (key, value) => {
        expect(() => normalizeRecruitmentSettingsInput({ [key]: value }))
            .toThrow(expect.objectContaining({ status: 400, code: "HR-RECRUITMENT-SETTINGS-INVALID" }));
    });

    it("accepts the range edges", () => {
        expect(normalizeRecruitmentSettingsInput({
            rejectionDelayHours: 0, knockoutDelayHours: 720, shortlistThreshold: 100, shortlistTopPercent: "0",
        })).toEqual({ rejectionDelayHours: 0, knockoutDelayHours: 720, shortlistThreshold: 100, shortlistTopPercent: 0 });
    });

    it("accepts https URLs only, and clears on null or blank", () => {
        expect(normalizeRecruitmentSettingsInput({ portalBaseUrl: " https://careers.acme.test/jobs " }))
            .toEqual({ portalBaseUrl: "https://careers.acme.test/jobs" });
        expect(normalizeRecruitmentSettingsInput({ companyUrl: null, companyLogoUrl: "   " }))
            .toEqual({ companyUrl: null, companyLogoUrl: null });
        for (const bad of ["http://acme.test", "ftp://acme.test", "javascript:alert(1)", "/relative", "not a url", "https://user:pw@acme.test"]) {
            expect(() => normalizeRecruitmentSettingsInput({ portalBaseUrl: bad }))
                .toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-SETTINGS-INVALID" }));
        }
    });

    it("allows only default channels that need no external URL, de-duplicated", () => {
        expect(normalizeRecruitmentSettingsInput({ defaultChannels: ["career_site", "CAREER_SITE"] }))
            .toEqual({ defaultChannels: ["CAREER_SITE"] });
        expect(normalizeRecruitmentSettingsInput({ defaultChannels: [] })).toEqual({ defaultChannels: [] });
        for (const bad of [["LINKEDIN"], ["INDEED"], ["NOPE"], [""], "CAREER_SITE"]) {
            expect(() => normalizeRecruitmentSettingsInput({ defaultChannels: bad }))
                .toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-SETTINGS-INVALID" }));
        }
    });

    it("requires a real boolean for feedEnabled and caps companyName", () => {
        expect(() => normalizeRecruitmentSettingsInput({ feedEnabled: "true" })).toThrow(expect.objectContaining({ status: 400 }));
        expect(() => normalizeRecruitmentSettingsInput({ companyName: "x".repeat(201) })).toThrow(expect.objectContaining({ status: 400 }));
        expect(normalizeRecruitmentSettingsInput({ companyName: "  Acme  " })).toEqual({ companyName: "Acme" });
    });
});

describe("Phase 3a scheduling and offer knobs", () => {
    it("accepts the knobs at their range edges", () => {
        expect(normalizeRecruitmentSettingsInput({
            slotOfferValidityHours: 1, feedbackNudgeHours: 0, feedbackEscalationHours: 720, offerReminderDays: 30,
            workdayStart: "08:30", workdayEnd: "17:45", timeZone: "Europe/London",
        })).toEqual({
            slotOfferValidityHours: 1, feedbackNudgeHours: 0, feedbackEscalationHours: 720, offerReminderDays: 30,
            workdayStart: "08:30", workdayEnd: "17:45", timeZone: "Europe/London",
        });
    });

    it.each([
        ["slotOfferValidityHours", 0],
        ["feedbackNudgeHours", 169],
        ["feedbackEscalationHours", 0],
        ["offerReminderDays", 31],
        ["workdayStart", "9:00"],
        ["workdayEnd", "24:00"],
        ["timeZone", "Mars/Olympus"],
        ["timeZone", ""],
    ])("rejects %s = %p", (key, value) => {
        expect(() => normalizeRecruitmentSettingsInput({ [key]: value }))
            .toThrow(expect.objectContaining({ status: 400, code: "HR-RECRUITMENT-SETTINGS-INVALID" }));
    });

    it("refuses a working window that would close before it opens, against the saved row", async () => {
        tx.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce({ ...ROW, workdayStart: "09:00", workdayEnd: "18:00" });
        await expect(updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: ROW.version, input: { workdayStart: "18:30" } }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-SETTINGS-INVALID" });
        expect(tx.tenantRecruitmentSettings.upsert).not.toHaveBeenCalled();
    });

    it("reads the defaults when never saved", async () => {
        db.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce(null);
        const settings = await getRecruitmentSettings({ tenantId: TENANT });
        expect(settings).toMatchObject({
            slotOfferValidityHours: 72, workdayStart: "09:00", workdayEnd: "18:00", timeZone: "Asia/Karachi",
            feedbackNudgeHours: 2, feedbackEscalationHours: 24, offerReminderDays: 3,
        });
    });
});

describe("updateRecruitmentSettings", () => {
    it("creates the row at version 1 under the advisory lock, from expectedVersion 0", async () => {
        const saved = await updateRecruitmentSettings({
            tenantId: TENANT, actorId: 5, expectedVersion: 0, input: { shortlistThreshold: 80 },
        });
        expect(tx.$executeRaw).toHaveBeenCalled();
        const args = tx.tenantRecruitmentSettings.upsert.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: TENANT });
        expect(args.create).toEqual({ tenantId: TENANT, shortlistThreshold: 80, updatedById: 5, version: 1 });
        expect(args.update).toEqual({ shortlistThreshold: 80, updatedById: 5, version: { increment: 1 } });
        expect(saved.version).toBe(1);
        expect(saved.hasFeedToken).toBe(false);
    });

    it("refuses a stale expectedVersion with 409 and writes nothing", async () => {
        tx.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce({ ...ROW });
        await expect(updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: 2, input: { shortlistThreshold: 80 } }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SETTINGS-VERSION-CONFLICT" });
        await expect(updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: 1, input: {} }))
            .rejects.toMatchObject({ status: 409 });
        expect(tx.tenantRecruitmentSettings.upsert).not.toHaveBeenCalled();
    });

    it("issues a feed token when the feed is enabled for the first time", async () => {
        const saved = await updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: 0, input: { feedEnabled: true } });
        const { create } = tx.tenantRecruitmentSettings.upsert.mock.calls[0][0];
        expect(create.feedToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(saved.feedToken).toBe(create.feedToken);
        expect(saved.hasFeedToken).toBe(true);
    });

    it("keeps the existing token on a plain save and replaces it on rotate", async () => {
        tx.tenantRecruitmentSettings.findUnique.mockResolvedValue({ ...ROW });
        tx.tenantRecruitmentSettings.upsert.mockImplementation(echoUpsert({ ...ROW }));

        const plain = await updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: 3, input: { companyName: "Acme Ltd" } });
        expect(tx.tenantRecruitmentSettings.upsert.mock.calls[0][0].update).not.toHaveProperty("feedToken");
        expect(plain.feedToken).toBe(ROW.feedToken);

        const rotated = await updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: 3, rotateFeedToken: true });
        const { update } = tx.tenantRecruitmentSettings.upsert.mock.calls[1][0];
        expect(update.feedToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(update.feedToken).not.toBe(ROW.feedToken);
        expect(rotated.feedToken).toBe(update.feedToken);
    });

    it("does not issue a token while the feed stays off", async () => {
        await updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: 0, input: { feedEnabled: false } });
        expect(tx.tenantRecruitmentSettings.upsert.mock.calls[0][0].create).not.toHaveProperty("feedToken");
    });

    it("validates before opening the transaction", async () => {
        await expect(updateRecruitmentSettings({ tenantId: TENANT, expectedVersion: 0, input: { portalBaseUrl: "http://x.test" } }))
            .rejects.toMatchObject({ status: 400 });
        expect(db.$transaction).not.toHaveBeenCalled();
    });
});
