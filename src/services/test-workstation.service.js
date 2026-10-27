// src/services/test-workstation.service.js
//
// Recruitment Phase 3b (plan 7.3.5) — registered KIOSK WORKSTATIONS.
//
// An HR admin registers each kiosk PC with a label and a site. The device
// holds a random workstation token (32 bytes, base64url); the server keeps
// only its sha256, so the token is shown exactly once: in the register (or
// rotate) answer. Revoking or rotating replaces what the server accepts at
// once: a revoked workstation fails verification on its status, and a rotated
// one no longer matches the old hash.
//
// verifyWorkstationToken is what the kiosk REST surface (stream I) calls on
// every request. The kiosk has no ERP user and no tenant, so the hash is
// looked up under SYSTEM context and everything after runs under the
// workstation's own tenant (the slot-offer token pattern). The stored and
// computed hashes are compared in constant time, an unknown token costs the
// same compare, and only ACTIVE workstations verify. A successful check
// stamps lastSeenAt at most once a minute, fail-soft.
//
// Flag onsiteTest: the admin tools refuse with 503
// HR-RECRUITMENT-ONSITE-TEST-DISABLED; verification answers null.
// The revocation reason has no column; it goes to the audit log (logAction).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { assertAssessmentCapability } from "../lib/assessment-access.util.js";
import { logAction } from "../utils/logs.js";

export const WORKSTATION_STATUS = Object.freeze({ ACTIVE: "ACTIVE", REVOKED: "REVOKED" });

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const LAST_SEEN_EVERY_MS = 60000;
const DUMMY_HASH = Buffer.alloc(32);

// Everything a workstation answer may carry: never the token or its hash.
const WORKSTATION_SELECT = Object.freeze({
    id: true,
    label: true,
    siteRef: true,
    status: true,
    tokenRotatedAt: true,
    lastSeenAt: true,
    registeredById: true,
    revokedAt: true,
    revokedById: true,
    createdAt: true,
});

const fail = (message, status, code) => Object.assign(new Error(message), { status, code, details: { code } });

function assertEnabled() {
    if (!isRecruitmentFlagEnabled("onsiteTest")) {
        throw fail("The on-site test is not enabled", 503, "HR-RECRUITMENT-ONSITE-TEST-DISABLED");
    }
}

function guard({ tenantId, access }) {
    assertEnabled();
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    assertAssessmentCapability(access, "admin", "Only an HR admin manages kiosk workstations");
}

export const hashWorkstationToken = (token) => createHash("sha256").update(String(token)).digest("hex");
const newToken = () => randomBytes(TOKEN_BYTES).toString("base64url");

function text(value, label, max = 100) {
    const out = typeof value === "string" ? value.trim() : "";
    if (!out || out.length > max) throw fail(`${label} is required (at most ${max} characters)`, 400, "HR-RECRUITMENT-WORKSTATION-INVALID");
    return out;
}

const toId = (value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw fail("workstationId must be a positive integer", 400, "HR-RECRUITMENT-WORKSTATION-INVALID");
    return n;
};

const notFound = () => fail("Workstation not found", 404, "HR-RECRUITMENT-WORKSTATION-NOT-FOUND");

async function audit({ tenantId, actorId, notes }) {
    await logAction({ employeeId: actorId ?? null, type: "UPDATE", module: "Assessment Workstations", result: "SUCCESS", notes, tenantId });
}

/** Register a kiosk. The token in the answer is the only time it is shown. */
export async function registerTestWorkstation({ tenantId, access, actorId = null, label, siteRef, now = new Date() } = {}) {
    guard({ tenantId, access });
    const token = newToken();
    const row = await prisma.testWorkstation.create({
        data: withTenant(tenantId, {
            label: text(label, "label"),
            siteRef: text(siteRef, "siteRef"),
            deviceTokenHash: hashWorkstationToken(token),
            tokenRotatedAt: new Date(now),
            status: WORKSTATION_STATUS.ACTIVE,
            registeredById: actorId,
        }),
        select: WORKSTATION_SELECT,
    });
    await audit({ tenantId, actorId, notes: `Kiosk workstation ${row.id} registered at site ${row.siteRef}` });
    return { workstation: row, deviceToken: token };
}

export async function listTestWorkstations({ tenantId, access, siteRef, status, page = 1, limit = 50 } = {}) {
    // Reception picks the kiosk a code is issued for, so it may list the
    // ACTIVE kiosks too; revoked ones and every other workstation action stay
    // with HR admins. The select never carries the token.
    const admin = access?.admin === true;
    if (admin) guard({ tenantId, access });
    else {
        assertEnabled();
        if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
        assertAssessmentCapability(access, "reception", "Only an HR admin or reception lists kiosk workstations");
    }
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const pageNo = Math.max(Number(page) || 1, 1);
    const shownStatus = admin ? status : WORKSTATION_STATUS.ACTIVE;
    // Sites are free text, matched case-insensitively like every other site check.
    const site = typeof siteRef === "string" && siteRef.trim() ? { siteRef: { equals: siteRef.trim(), mode: "insensitive" } } : {};
    const where = withTenant(tenantId, { ...site, ...(shownStatus ? { status: shownStatus } : {}) });
    const [items, total] = await Promise.all([
        prisma.testWorkstation.findMany({ where, select: WORKSTATION_SELECT, orderBy: [{ siteRef: "asc" }, { label: "asc" }, { id: "asc" }], skip: (pageNo - 1) * take, take }),
        prisma.testWorkstation.count({ where }),
    ]);
    return { items, total, page: pageNo, limit: take };
}

/** Revoke at once: the status check in verifyWorkstationToken stops the token. */
export async function revokeTestWorkstation({ tenantId, access, actorId = null, workstationId, reason, now = new Date() } = {}) {
    guard({ tenantId, access });
    const id = toId(workstationId);
    const why = text(reason, "reason", 500);
    const { count } = await prisma.testWorkstation.updateMany({
        where: withTenant(tenantId, { id, status: WORKSTATION_STATUS.ACTIVE }),
        data: { status: WORKSTATION_STATUS.REVOKED, revokedAt: new Date(now), revokedById: actorId },
    });
    const row = await prisma.testWorkstation.findFirst({ where: withTenant(tenantId, { id }), select: WORKSTATION_SELECT });
    if (!row) throw notFound();
    if (count) await audit({ tenantId, actorId, notes: `Kiosk workstation ${id} revoked: ${why}` });
    return { workstation: row, revoked: count > 0 };
}

/** Issue a new token (shown once); the old one stops matching at once. */
export async function rotateTestWorkstationToken({ tenantId, access, actorId = null, workstationId, now = new Date() } = {}) {
    guard({ tenantId, access });
    const id = toId(workstationId);
    const token = newToken();
    const { count } = await prisma.testWorkstation.updateMany({
        where: withTenant(tenantId, { id, status: WORKSTATION_STATUS.ACTIVE }),
        data: { deviceTokenHash: hashWorkstationToken(token), tokenRotatedAt: new Date(now) },
    });
    if (!count) {
        const exists = await prisma.testWorkstation.findFirst({ where: withTenant(tenantId, { id }), select: { id: true } });
        if (!exists) throw notFound();
        throw fail("A revoked workstation cannot be rotated; register it again", 409, "HR-RECRUITMENT-WORKSTATION-REVOKED");
    }
    const row = await prisma.testWorkstation.findFirst({ where: withTenant(tenantId, { id }), select: WORKSTATION_SELECT });
    await audit({ tenantId, actorId, notes: `Kiosk workstation ${id} token rotated` });
    return { workstation: row, deviceToken: token };
}

function sameHash(storedHex, computedHex) {
    const computed = Buffer.from(computedHex, "hex");
    const stored = typeof storedHex === "string" && /^[0-9a-f]{64}$/.test(storedHex) ? Buffer.from(storedHex, "hex") : DUMMY_HASH;
    return timingSafeEqual(stored, computed) && stored !== DUMMY_HASH;
}

async function touchLastSeen(row, now) {
    const seen = row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0;
    if (now.getTime() - seen < LAST_SEEN_EVERY_MS) return;
    try {
        await prisma.testWorkstation.updateMany({ where: withTenant(row.tenantId, { id: row.id, status: WORKSTATION_STATUS.ACTIVE }), data: { lastSeenAt: now } });
    } catch (err) {
        logger.warn({ err, workstationId: row.id }, "workstation lastSeenAt update failed");
    }
}

/**
 * The kiosk's credential check. Returns { id, tenantId, label, siteRef,
 * status, lastSeenAt } for an ACTIVE workstation whose token matches, else
 * null (flag off, malformed, unknown, revoked or rotated away).
 */
export async function verifyWorkstationToken(rawToken, { now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("onsiteTest")) return null;
    if (typeof rawToken !== "string" || !TOKEN_RE.test(rawToken)) return null;
    const hash = hashWorkstationToken(rawToken);
    const ref = await mcpCtx.run({ system: true }, async () =>
        await prisma.testWorkstation.findUnique({ where: { deviceTokenHash: hash }, select: { id: true, tenantId: true, deviceTokenHash: true } }),
    );
    if (!sameHash(ref?.deviceTokenHash, hash) || !ref?.tenantId) return null;
    const at = new Date(now);
    return mcpCtx.run({ user: { tenantId: ref.tenantId }, system: false }, async () => {
        const row = await prisma.testWorkstation.findFirst({
            where: withTenant(ref.tenantId, { id: ref.id, status: WORKSTATION_STATUS.ACTIVE, deviceTokenHash: hash }),
            select: { id: true, tenantId: true, label: true, siteRef: true, status: true, lastSeenAt: true },
        });
        if (!row) return null;
        await touchLastSeen(row, at);
        return row;
    });
}
