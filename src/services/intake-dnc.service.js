// src/services/intake-dnc.service.js
//
// Recruitment Phase 2 / D-11 — the do-not-contact register at EVERY intake
// path, not only on offer send. One helper, two ways to answer a hit:
//
//   * PUBLIC paths (portal apply, draft save, status-link request) must not
//     reveal that the address is on the register: the caller creates nothing,
//     sends nothing, and returns exactly the response a success returns. The
//     only trace is a pino line with the tenant and a HASH of the address.
//   * INTERNAL paths (a recruiter creating a candidate or an application,
//     moving a pool candidate into a pipeline) refuse with 409
//     HR-RECRUITMENT-CANDIDATE-DNC. The message never echoes the address: the
//     error travels through logs and tool envelopes that outlive the request.
//
// Scope: CandidateDncEntry.scope is "ALL" by default. Intake is processing AND
// email contact, so every scope blocks it except the ones that name a channel
// intake never uses (SMS, PHONE, MARKETING). An unknown scope blocks: a
// register entry the code does not understand is treated as the strict one.
//
// The intake SOURCE vocabulary lives here too (bottom of the file): every path
// that runs the DNC gate also stamps Application.sourceChannel, and both the
// portal and the recruiter path must agree on the closed list the migration's
// CHECK constraint enforces.
import crypto from "node:crypto";

import logger from "../lib/logger.js";
// Namespace import: the privacy service is a large module that several test
// suites replace with a partial double; a named import of a missing export
// fails at link time for every importer, a property read fails only here.
import * as candidatePrivacy from "./candidatePrivacy.service.js";

export const INTAKE_DNC_CODE = "HR-RECRUITMENT-CANDIDATE-DNC";

const NON_INTAKE_SCOPES = new Set(["SMS", "PHONE", "MARKETING"]);

const normalize = (email) => String(email ?? "").trim().toLowerCase();

/** Whether a DNC entry's scope covers intake. */
export function dncScopeBlocksIntake(scope) {
    const value = String(scope ?? "ALL").trim().toUpperCase() || "ALL";
    return !NON_INTAKE_SCOPES.has(value);
}

/**
 * Probe the register for one address.
 *
 * @param {{ tenantId: string, email: string, tx?: object, at?: Date }} args
 *   tx — the caller's transaction (the probe must see the tenant GUC the
 *        caller's writes run under); defaults to the singleton client.
 * @returns {Promise<{ blocked: boolean, reason: string|null }>} reason is the
 *   entry's compliance reasonCode when blocked, never the address.
 */
export async function checkIntakeDnc({ tenantId, email, tx, at = new Date() } = {}) {
    const normalized = normalize(email);
    if (!normalized) return { blocked: false, reason: null };
    const entry = await candidatePrivacy.findActiveDnc({ tenantId, email: normalized, at }, tx ? { db: tx } : {});
    if (!entry || !dncScopeBlocksIntake(entry.scope)) return { blocked: false, reason: null };
    return { blocked: true, reason: entry.reasonCode ?? "DNC" };
}

/** The 409 an internal intake path throws for a register hit. */
export function intakeDncError() {
    return Object.assign(
        new Error("This candidate is on the do-not-contact register; the intake was not recorded"),
        { status: 409, code: INTAKE_DNC_CODE },
    );
}

/** Internal paths: throw the 409 when the address is on the register. */
export async function assertIntakeAllowed(args) {
    const result = await checkIntakeDnc(args);
    if (result.blocked) throw intakeDncError();
    return result;
}

/**
 * A stable, non-reversible-at-a-glance reference to an address for logs:
 * sha256 over tenant + address, truncated. Correlates repeated attempts in
 * one tenant without writing the address anywhere.
 */
export function hashEmailForLog(tenantId, email) {
    return crypto.createHash("sha256").update(`${tenantId ?? ""}:${normalize(email)}`).digest("hex").slice(0, 16);
}

/** Public paths: the one log line a suppressed intake leaves. */
export function logIntakeSuppressed({ tenantId, email, path, reason = null }) {
    logger.info(
        { tenantId, emailHash: hashEmailForLog(tenantId, email), path, reason },
        "intake suppressed: address is on the do-not-contact register",
    );
}

// ── Intake source attribution ───────────────────────────────────────────────

// Mirrors the Application_sourceChannel_check constraint (20261021003100).
export const APPLICATION_SOURCE_CHANNELS = Object.freeze([
    "CAREER_SITE",
    "LINKEDIN",
    "INDEED",
    "REFERRAL",
    "AGENCY",
    "TALENT_POOL",
    "INTERNAL",
    "RECRUITER",
    "OTHER",
]);

export const SOURCE_DETAIL_MAX_LENGTH = 200;

/**
 * A caller-supplied channel, normalized: absent -> the path's default, a known
 * value upper-cased, anything else OTHER (an unknown channel is still a
 * channel; refusing the application over a tracking parameter would be worse).
 */
export function normalizeSourceChannel(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    const channel = String(value).trim().toUpperCase();
    return APPLICATION_SOURCE_CHANNELS.includes(channel) ? channel : "OTHER";
}

/** A short campaign detail: trimmed, capped at the column's CHECK length, or null. */
export function normalizeSourceDetail(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim().slice(0, SOURCE_DETAIL_MAX_LENGTH);
    return text || null;
}
