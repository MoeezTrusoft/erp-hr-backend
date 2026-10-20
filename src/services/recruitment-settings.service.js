// src/services/recruitment-settings.service.js
//
// Phase 2 — one TenantRecruitmentSettings row per tenant holds the knobs the
// intake and screening features read: default publication channels, the
// knockout and rejection delays, the shortlist thresholds, the job feed switch
// and token, and the employer facts the feed and the portal render.
//
// Mirrors attendancePolicyConfig.service.js: reads go through the RLS
// extension, the upsert runs inside tenantTransaction under a per-tenant
// advisory lock, and an expectedVersion that no longer matches is a 409. A
// tenant with no row reads the defaults with id null ("never configured").
//
// The feed token is never returned by getRecruitmentSettings; callers that
// need it (the settings tool, for the recruiter who rotates it) ask for it.
import { randomBytes } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { CHANNELS_REQUIRING_URL, PUBLICATION_CHANNELS } from "../lib/requisitionPublication.js";

const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });

// Each integer knob: [min, max]. The migration's CHECK constraint holds the
// same ranges, so a write that slips past here still cannot land.
const INT_RANGES = Object.freeze({
    rejectionDelayHours: [0, 720],
    knockoutDelayHours: [0, 720],
    shortlistThreshold: [0, 100],
    shortlistTopPercent: [0, 100],
});

const TEXT_KEYS = Object.freeze({ companyName: 200 });
const URL_KEYS = Object.freeze(["companyUrl", "companyLogoUrl", "portalBaseUrl"]);

export const RECRUITMENT_SETTINGS_DEFAULTS = Object.freeze({
    defaultChannels: [],
    rejectionDelayHours: 48,
    knockoutDelayHours: 24,
    shortlistThreshold: 70,
    shortlistTopPercent: 10,
    feedEnabled: false,
    companyName: null,
    companyUrl: null,
    companyLogoUrl: null,
    portalBaseUrl: null,
});

export function defaultRecruitmentSettings(tenantId = null) {
    return {
        id: null,
        tenantId,
        ...RECRUITMENT_SETTINGS_DEFAULTS,
        defaultChannels: [],
        hasFeedToken: false,
        version: 0,
        updatedById: null,
        updatedAt: null,
    };
}

function present(row, { includeFeedToken = false } = {}) {
    if (!row) return null;
    const { feedToken, ...rest } = row;
    return {
        id: row.tenantId,
        ...rest,
        hasFeedToken: Boolean(feedToken),
        ...(includeFeedToken ? { feedToken: feedToken ?? null } : {}),
    };
}

/**
 * The tenant's effective recruitment settings (defaults when never saved).
 * @param {{ tenantId: string, includeFeedToken?: boolean }} args
 */
export async function getRecruitmentSettings({ tenantId, includeFeedToken = false } = {}) {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
    const row = await prisma.tenantRecruitmentSettings.findUnique({ where: { tenantId } });
    return present(row, { includeFeedToken }) ?? defaultRecruitmentSettings(tenantId);
}

function normalizeUrl(key, raw) {
    // A blank (or whitespace-only) value clears the field, like null.
    const text = raw === null ? "" : String(raw).trim();
    if (!text) return null;
    let url;
    try {
        url = new URL(text);
    } catch {
        throw fail(`${key} must be an absolute https URL`, "HR-RECRUITMENT-SETTINGS-INVALID");
    }
    if (url.protocol !== "https:") throw fail(`${key} must be an https URL`, "HR-RECRUITMENT-SETTINGS-INVALID");
    // These URLs are published (feed, portal links); a credential in one would
    // be published with it.
    if (url.username || url.password) {
        throw fail(`${key} must not contain a user name or password`, "HR-RECRUITMENT-SETTINGS-INVALID");
    }
    const value = url.toString();
    if (value.length > 500) throw fail(`${key} is too long`, "HR-RECRUITMENT-SETTINGS-INVALID");
    return value;
}

function normalizeChannels(raw) {
    if (!Array.isArray(raw)) throw fail("defaultChannels must be a list", "HR-RECRUITMENT-SETTINGS-INVALID");
    const out = [];
    for (const entry of raw) {
        const channel = String(entry ?? "").trim().toUpperCase();
        // Auto-publish runs unattended and has no URL to record, so only the
        // self-hosted channels qualify (resolveDefaultPublicationChannels).
        if (!PUBLICATION_CHANNELS.includes(channel) || CHANNELS_REQUIRING_URL.includes(channel)) {
            throw fail(
                `defaultChannels accepts only channels that need no external URL (got ${channel || "empty"})`,
                "HR-RECRUITMENT-SETTINGS-INVALID",
            );
        }
        if (!out.includes(channel)) out.push(channel);
    }
    return out;
}

/** Validate a partial settings payload into column data. Pure. */
export function normalizeRecruitmentSettingsInput(input = {}) {
    const data = {};
    for (const [key, [min, max]] of Object.entries(INT_RANGES)) {
        if (input[key] === undefined) continue;
        // Number() would read null, "", true and [] as 0 or 1; only a number or
        // a numeric string is a value here.
        const raw = input[key];
        const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
        if (!Number.isInteger(n) || n < min || n > max) {
            throw fail(`${key} must be a whole number between ${min} and ${max}`, "HR-RECRUITMENT-SETTINGS-INVALID");
        }
        data[key] = n;
    }
    for (const [key, max] of Object.entries(TEXT_KEYS)) {
        if (input[key] === undefined) continue;
        const value = input[key] === null ? null : String(input[key]).trim();
        if (value && value.length > max) throw fail(`${key} is too long`, "HR-RECRUITMENT-SETTINGS-INVALID");
        data[key] = value || null;
    }
    for (const key of URL_KEYS) {
        if (input[key] !== undefined) data[key] = normalizeUrl(key, input[key]);
    }
    if (input.defaultChannels !== undefined) data.defaultChannels = normalizeChannels(input.defaultChannels);
    if (input.feedEnabled !== undefined) {
        if (typeof input.feedEnabled !== "boolean") {
            throw fail("feedEnabled must be true or false", "HR-RECRUITMENT-SETTINGS-INVALID");
        }
        data.feedEnabled = input.feedEnabled;
    }
    return data;
}

const newFeedToken = () => randomBytes(24).toString("base64url");

/**
 * Save part of the tenant's recruitment settings.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {number|null} [args.actorId]
 * @param {number} [args.expectedVersion]  the version the caller read (0 = never saved)
 * @param {boolean} [args.rotateFeedToken] issue a new feed token (the old URL stops working)
 * @param {object} args.input  the fields to change
 */
export async function updateRecruitmentSettings({
    tenantId,
    actorId = null,
    expectedVersion,
    rotateFeedToken = false,
    input = {},
} = {}) {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
    const data = normalizeRecruitmentSettingsInput(input);

    const row = await tenantTransaction(prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:recruitment-settings`}))`;
        const latest = await tx.tenantRecruitmentSettings.findUnique({ where: { tenantId } });
        if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== (latest?.version ?? 0)) {
            throw fail(
                "Recruitment settings changed; refresh before saving",
                "HR-RECRUITMENT-SETTINGS-VERSION-CONFLICT",
                409,
            );
        }
        // Enabling the feed without a token issues one: an enabled feed with no
        // URL would be a switch that does nothing.
        const enablingFeed = data.feedEnabled ?? latest?.feedEnabled ?? false;
        const token = rotateFeedToken || (enablingFeed && !latest?.feedToken) ? newFeedToken() : undefined;
        const write = { ...data, ...(token ? { feedToken: token } : {}), updatedById: actorId ?? null };
        return tx.tenantRecruitmentSettings.upsert({
            where: { tenantId },
            create: { tenantId, ...write, version: 1 },
            update: { ...write, version: { increment: 1 } },
        });
    });

    logger.info(
        { tenantId, version: row.version, fields: Object.keys(data), rotatedFeedToken: Boolean(rotateFeedToken) },
        "recruitment settings updated",
    );
    return present(row, { includeFeedToken: true });
}
