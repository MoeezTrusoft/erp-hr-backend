// src/services/job-feed.service.js
//
// Phase 2 — the per-tenant XML job feed job boards pull.
//
// A tenant that switches the feed on gets a secret URL per channel,
//     /public/feeds/<feedToken>/indeed.xml   and   .../linkedin.xml
// and the board crawls it. The request is anonymous and carries no tenant, so
// the token IS the tenant lookup: it is read under SYSTEM context (FORCE RLS
// would hide every row from a context-less read), and the jobs are then read
// under THAT tenant's own context, so the second query can only ever see the
// one tenant the token named.
//
// Every refusal is the same `null` (the route renders one identical 404): flag
// off, malformed or unknown token, feed switched off, channel not a feed
// channel. A caller must not be able to tell a stale token from a disabled feed.
//
// Only public fields leave: title, location, employment type and the published
// jobContent, the same projection the careers portal uses. Salary is never in
// the feed (the requisition has no "salary is public" marker), nor are notes,
// the hiring manager, approval or budget data.
import { createHash, timingSafeEqual } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
    buildJobDescriptionHtml,
    buildJobFeedXml,
    feedJobType,
    splitLocation,
} from "../lib/job-feed-xml.util.js";

const log = logger.child({ component: "job-feed" });

// The channels a feed is served for. Each is an external board whose apply
// link brings the candidate back to the portal tagged with that channel.
export const FEED_CHANNELS = Object.freeze(["INDEED", "LINKEDIN"]);

// A board does not need more than this in one document, and an unbounded
// anonymous query is a cost nobody signed up for.
export const MAX_FEED_JOBS = 500;

export const JOB_FEED_PATH_PREFIX = "/public/feeds";

// Tokens are randomBytes(24) in base64url (32 chars). Anything that cannot be
// one is refused before it reaches the database.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** "indeed" / "INDEED" -> "INDEED"; anything that is not a feed channel -> null. */
export function normalizeFeedChannel(raw) {
    const channel = String(raw ?? "").trim().toUpperCase();
    return FEED_CHANNELS.includes(channel) ? channel : null;
}

const trimSlash = (value) => String(value ?? "").trim().replace(/\/+$/, "");

/**
 * The apply link for one job on one channel:
 *     ${portalBaseUrl}/jobs/${requisitionId}?source=${CHANNEL}&posting=${postingId}
 * The portal's apply path reads `source` and `posting` into the application's
 * sourceChannel / sourcePostingId. Null without a portalBaseUrl: an apply link
 * nobody can reach is not a listing.
 */
export function buildApplyUrl({ portalBaseUrl, requisitionId, channel, postingId }) {
    const base = trimSlash(portalBaseUrl);
    if (!base) return null;
    const params = new URLSearchParams({ source: channel, posting: String(postingId) });
    return `${base}/jobs/${encodeURIComponent(String(requisitionId))}?${params.toString()}`;
}

/** The path of a tenant's feed for one channel (lowercase channel segment). */
export function jobFeedPath(token, channel) {
    return `${JOB_FEED_PATH_PREFIX}/${encodeURIComponent(token)}/${String(channel).toLowerCase()}.xml`;
}

/**
 * The feed's location for each channel, for the recruiter who registers it with
 * the board. `urls` is absolute when HR_JOB_FEED_BASE_URL (the public origin
 * that routes /public/feeds to this service) is configured, else null.
 */
export function buildJobFeedUrls(token, { baseUrl = process.env.HR_JOB_FEED_BASE_URL } = {}) {
    if (!token) return null;
    const base = trimSlash(baseUrl);
    const paths = Object.fromEntries(FEED_CHANNELS.map((channel) => [channel, jobFeedPath(token, channel)]));
    const urls = Object.fromEntries(FEED_CHANNELS.map((channel) => [channel, base ? `${base}${paths[channel]}` : null]));
    return { paths, urls };
}

// Compare digests so the comparison is constant time whatever the lengths.
const digest = (value) => createHash("sha256").update(String(value)).digest();
export const tokensMatch = (a, b) =>
    typeof a === "string" && typeof b === "string" && timingSafeEqual(digest(a), digest(b));

// The ONLY requisition fields the feed reads (see the header comment).
const feedSelect = (tenantId, channel) => ({
    id: true,
    title: true,
    location: true,
    employmentType: true,
    publishedAt: true,
    jobContent: true,
    postings: {
        where: withTenant(tenantId, { channel, isActive: true, closedAt: null }),
        select: { id: true, postedAt: true },
        orderBy: { postedAt: "desc" },
        take: 1,
    },
});

// Prisma queries are lazy: they run when awaited, so the await must happen
// INSIDE mcpCtx.run or the query executes outside the context it was given.
async function findFeedSettings(token) {
    return mcpCtx.run({ system: true }, async () =>
        await prisma.tenantRecruitmentSettings.findUnique({
            where: { feedToken: token },
            select: {
                tenantId: true,
                feedToken: true,
                feedEnabled: true,
                companyName: true,
                companyUrl: true,
                portalBaseUrl: true,
            },
        }),
    );
}

async function findFeedRequisitions({ tenantId, channel, now }) {
    return mcpCtx.run({ user: { tenantId } }, async () =>
        await prisma.jobRequisition.findMany({
            where: withTenant(tenantId, {
                status: "POSTED",
                // The closing instant still belongs to the window
                // (requisitionEligibility), hence gte.
                OR: [{ closesAt: null }, { closesAt: { gte: now } }],
                postings: { some: withTenant(tenantId, { channel, isActive: true, closedAt: null }) },
            }),
            select: feedSelect(tenantId, channel),
            orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
            take: MAX_FEED_JOBS,
        }),
    );
}

/** One requisition as a feed job, or null when it cannot be listed. Pure. */
export function toFeedJob(requisition, { channel, settings }) {
    const posting = requisition.postings?.[0];
    if (!posting) return null;
    const url = buildApplyUrl({
        portalBaseUrl: settings.portalBaseUrl,
        requisitionId: requisition.id,
        channel,
        postingId: posting.id,
    });
    if (!url) return null;
    return {
        title: requisition.title,
        date: posting.postedAt ?? requisition.publishedAt,
        referenceNumber: String(requisition.id),
        url,
        company: settings.companyName ?? "",
        ...splitLocation(requisition.location),
        description: buildJobDescriptionHtml(requisition.jobContent),
        jobType: feedJobType(requisition.employmentType),
    };
}

/**
 * The feed document for a token and channel, or null for every not-found case.
 *
 * @param {{ token: string, channel: string, now?: Date }} args
 * @returns {Promise<{ xml: string, tenantId: string, channel: string, jobCount: number } | null>}
 */
export async function getJobFeed({ token, channel, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("jobFeed")) return null;
    const feedChannel = normalizeFeedChannel(channel);
    if (!feedChannel) return null;
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;

    const settings = await findFeedSettings(token);
    if (!settings || !tokensMatch(settings.feedToken, token) || settings.feedEnabled !== true) return null;

    const requisitions = await findFeedRequisitions({ tenantId: settings.tenantId, channel: feedChannel, now });
    const jobs = requisitions
        .map((requisition) => toFeedJob(requisition, { channel: feedChannel, settings }))
        .filter(Boolean);
    if (requisitions.length && !settings.portalBaseUrl) {
        log.warn(
            { tenantId: settings.tenantId, channel: feedChannel, left: requisitions.length },
            "job feed: portalBaseUrl is not set, so no job has an apply URL",
        );
    }

    const xml = buildJobFeedXml({
        publisher: settings.companyName,
        publisherUrl: settings.companyUrl ?? settings.portalBaseUrl,
        lastBuildDate: now,
        jobs,
    });
    return { xml, tenantId: settings.tenantId, channel: feedChannel, jobCount: jobs.length };
}
