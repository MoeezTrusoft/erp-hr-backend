// src/services/offer-letter.service.js
//
// Recruitment Phase 3a — versioned offer letter TEMPLATES and the rendered
// letter VERSIONS (flag offerLetters).
//
// Templates
//   * IMMUTABLE VERSIONS. Saving a template creates the next version of its key
//     (STANDARD, CONTRACT, ...); a version is never edited. Saving deactivates
//     nothing: the NEWEST ACTIVE version of a key is the one rendered, so
//     deactivating the newest one falls back to the one before it.
//   * A BUILT-IN DEFAULT. A tenant that never saved a template renders the
//     STANDARD letter defined below, version 0, labelled builtIn. It lives in
//     code (not in the table, whose versions start at 1) so it can never be
//     edited or deactivated by a tenant.
//   * CLOSED MERGE FIELDS. The body is validated by the pure renderer
//     (lib/offer-letter-template.util.js): unknown {{fields}} are refused with
//     the allowed list, and the body is capped at 50 KB.
//
// Versions
//   * WHO MAY RENDER. A letter prints the salary, so only scopes that may see
//     compensation (ORG, FINANCE: canSeeCompensation, the same rule as
//     maskOfferForScope) may render one. The versions list is readable by any
//     scope that can reach the offer, without media ids or content hashes for
//     the scopes that may not see compensation (a hash of a known template is
//     a salary oracle by brute force).
//   * WHAT A RENDER WRITES. The PDF goes to DAM first (it is outside the
//     database), then one transaction locks the offer, re-checks its status,
//     creates OfferLetterVersion (version = max + 1, contentHash = sha256 of
//     the rendered text), points Offer.offerLetterMediaId at it (the column the
//     send path and the handoff already read) and enqueues
//     hr.recruitment.offer_letter_rendered.v1 (ids only).
//   * WHEN A RENDER IS REFUSED. On a closed offer (ACCEPTED, DECLINED, EXPIRED,
//     WITHDRAWN), and while the newest letter is out for signature or signed:
//     a new version would leave the candidate signing a letter that is no
//     longer the current one. Void the envelope first.
//   * AN UNCHANGED RENDER IS A REPLAY. The same template version and the same
//     rendered text as the newest (unsent) version returns that version, so a
//     double click does not make version 2 of an identical letter.
import crypto from "node:crypto";

import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { RECRUITMENT_SCOPE, offerScopeWhere } from "../lib/recruitmentAccess.js";
import { eventContext } from "../lib/event-context.util.js";
import {
    MERGE_FIELDS,
    buildMergeValues,
    normalizeTemplateKey,
    renderOfferLetter,
    validateOfferLetterTemplate,
} from "../lib/offer-letter-template.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { generateOfferLetterPdf, uploadOfferLetterPdf } from "./offer-letter-pdf.service.js";

export const OFFER_LETTER_RENDERED_EVENT = "hr.recruitment.offer_letter_rendered.v1";
export const DEFAULT_TEMPLATE_KEY = "STANDARD";
export const CLOSED_OFFER_STATUSES = Object.freeze(["ACCEPTED", "DECLINED", "EXPIRED", "WITHDRAWN"]);
// Letters in these states are with the candidate (or done): no new version.
export const LOCKED_SIGNATURE_STATUSES = Object.freeze(["SENT", "VIEWED", "SIGNED"]);

const SAVE_ATTEMPTS = 3;

const fail = (message, status, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

// ── The built-in default ─────────────────────────────────────────────────────

export const BUILT_IN_STANDARD_TEMPLATE = Object.freeze({
    id: null,
    key: DEFAULT_TEMPLATE_KEY,
    version: 0,
    builtIn: true,
    active: true,
    name: "Standard offer letter (built-in default)",
    subject: "Offer of employment: {{job.title}}",
    body: [
        "{{today}}",
        "Dear {{candidate.firstName}} {{candidate.lastName}},",
        "We are pleased to offer you the position of {{job.title}} at {{company.name}}, on a {{offer.employmentType}} basis, starting on {{offer.startDate}}.",
        "Your base salary will be {{offer.currency}} {{offer.salary}}. Benefits: {{offer.benefits}}.",
        "Your employment is subject to a probation period of {{offer.probationMonths}} month(s) and a notice period of {{offer.noticePeriodDays}} day(s).",
        "This offer is valid until {{offer.expiryDate}}. Please sign this letter to confirm that you accept it.",
        "We look forward to welcoming you to the team.",
        "Sincerely,\nHuman Resources\n{{company.name}}",
    ].join("\n\n"),
    createdAt: null,
    createdById: null,
});

// ── Guards ───────────────────────────────────────────────────────────────────

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
};

const requireOfferLettersEnabled = () => {
    if (!isRecruitmentFlagEnabled("offerLetters")) {
        throw fail("Offer letters are disabled", 503, "HR-RECRUITMENT-OFFER-LETTERS-DISABLED");
    }
};

const requireOrgScope = (scope) => {
    if (scope?.level !== RECRUITMENT_SCOPE.ORG) {
        throw fail("Only recruiters can manage offer letter templates", 403, "HR-RECRUITMENT-OFFER-LETTER-FORBIDDEN");
    }
};

const requireCompensationScope = (scope) => {
    if (!scope?.canSeeCompensation) {
        throw fail("Rendering an offer letter needs access to compensation", 403, "HR-RECRUITMENT-OFFER-LETTER-FORBIDDEN");
    }
};

const positiveId = (value, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw fail(`A valid ${label} is required`, 400, "HR-RECRUITMENT-OFFER-LETTER-INVALID");
    return n;
};

const requireKey = (raw) => {
    const key = normalizeTemplateKey(raw);
    if (!key) {
        throw fail("key must be a short upper-case name such as STANDARD or CONTRACT", 422, "HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-INVALID");
    }
    return key;
};

// ── Event ────────────────────────────────────────────────────────────────────

/** hr.recruitment.offer_letter_rendered.v1 — ids and template vocabulary only. */
export function offerLetterRenderedEvent(row, ctx = {}) {
    if (!row?.tenantId) return null;
    return {
        eventName: OFFER_LETTER_RENDERED_EVENT,
        tenantId: row.tenantId,
        aggregateType: "OfferLetterVersion",
        aggregateId: row.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            offerLetterVersionId: String(row.id),
            offerId: String(row.offerId),
            version: row.version,
            templateKey: row.templateKey,
            templateVersion: row.templateVersion,
        },
    };
}

// ── Templates ────────────────────────────────────────────────────────────────

const presentTemplate = (row, inUseIds = new Set()) => ({
    id: row.id,
    key: row.key,
    version: row.version,
    name: row.name,
    subject: row.subject ?? null,
    body: row.body,
    active: row.active,
    builtIn: Boolean(row.builtIn),
    inUse: row.builtIn ? Boolean(row.inUse) : inUseIds.has(row.id),
    createdById: row.createdById ?? null,
    createdAt: row.createdAt ?? null,
});

/** The newest active tenant version of a key, or null. */
async function findNewestActiveTemplate(db, tenantId, key) {
    return await db.offerLetterTemplate.findFirst({
        where: withTenant(tenantId, { key, active: true }),
        orderBy: { version: "desc" },
    });
}

/**
 * The template a render uses. An explicit key must exist (or be STANDARD); a
 * key derived from the offer's type falls back to STANDARD, and STANDARD to
 * the built-in default.
 */
export async function resolveOfferLetterTemplate({ tenantId, key, explicit = false }, db = prisma) {
    const wanted = normalizeTemplateKey(key) ?? DEFAULT_TEMPLATE_KEY;
    const found = await findNewestActiveTemplate(db, tenantId, wanted);
    if (found) return found;
    if (wanted !== DEFAULT_TEMPLATE_KEY) {
        if (explicit) throw fail(`No active offer letter template ${wanted}`, 404, "HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-NOT-FOUND");
        const standard = await findNewestActiveTemplate(db, tenantId, DEFAULT_TEMPLATE_KEY);
        if (standard) return standard;
    }
    return BUILT_IN_STANDARD_TEMPLATE;
}

/**
 * List the tenant's templates (every version, newest first per key) plus the
 * built-in default. Scopes outside ORG / MANAGED / FINANCE see an empty list.
 */
export async function listOfferLetterTemplates({ tenantId, scope, key = null, includeInactive = true } = {}) {
    requireTenant(tenantId);
    requireOfferLettersEnabled();
    const allowed = [RECRUITMENT_SCOPE.ORG, RECRUITMENT_SCOPE.MANAGED, RECRUITMENT_SCOPE.FINANCE].includes(scope?.level);
    if (!allowed) return { items: [], builtInDefault: null, mergeFields: [...MERGE_FIELDS] };

    const where = withTenant(tenantId, {});
    if (key) where.key = requireKey(key);
    if (!includeInactive) where.active = true;
    const rows = await prisma.offerLetterTemplate.findMany({
        where,
        orderBy: [{ key: "asc" }, { version: "desc" }],
        take: 500,
    });
    // Newest active per key = the one a render uses.
    const inUse = new Set();
    const seenKeys = new Set();
    for (const row of rows) {
        if (row.active && !seenKeys.has(row.key)) {
            inUse.add(row.id);
            seenKeys.add(row.key);
        }
    }
    const standardInUse = !rows.some((r) => r.key === DEFAULT_TEMPLATE_KEY && r.active);
    return {
        items: rows.map((row) => presentTemplate(row, inUse)),
        builtInDefault: presentTemplate({ ...BUILT_IN_STANDARD_TEMPLATE, inUse: standardInUse }),
        mergeFields: [...MERGE_FIELDS],
    };
}

/** Save a template: the next version of its key, active. ORG only. */
export async function saveOfferLetterTemplate({ tenantId, scope, actorId = null, key, name, subject, body } = {}) {
    requireTenant(tenantId);
    requireOfferLettersEnabled();
    requireOrgScope(scope);
    const cleanKey = requireKey(key);
    const clean = validateOfferLetterTemplate({ name, subject, body });

    for (let attempt = 1; ; attempt += 1) {
        try {
            const row = await tenantTransaction(prisma, async (tx) => {
                const newest = await tx.offerLetterTemplate.findFirst({
                    where: withTenant(tenantId, { key: cleanKey }),
                    orderBy: { version: "desc" },
                    select: { version: true },
                });
                return await tx.offerLetterTemplate.create({
                    data: {
                        tenantId,
                        key: cleanKey,
                        version: (newest?.version ?? 0) + 1,
                        name: clean.name,
                        subject: clean.subject,
                        body: clean.body,
                        active: true,
                        createdById: actorId ?? null,
                    },
                });
            }, { tenantId });
            return presentTemplate(row, new Set([row.id]));
        } catch (err) {
            // Two saves of the same key raced for the same version number.
            if (err?.code === "P2002" && attempt < SAVE_ATTEMPTS) continue;
            if (err?.code === "P2002") {
                throw fail("Another save of this template won; reload and try again", 409, "HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-CONFLICT");
            }
            throw err;
        }
    }
}

/** Deactivate one template version. ORG only; idempotent. */
export async function deactivateOfferLetterTemplate({ tenantId, scope, id } = {}) {
    requireTenant(tenantId);
    requireOfferLettersEnabled();
    requireOrgScope(scope);
    const templateId = positiveId(id, "template id");
    return await tenantTransaction(prisma, async (tx) => {
        const existing = await tx.offerLetterTemplate.findFirst({ where: withTenant(tenantId, { id: templateId }) });
        if (!existing) throw fail("Offer letter template not found", 404, "HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-NOT-FOUND");
        if (existing.active) {
            await tx.offerLetterTemplate.updateMany({ where: withTenant(tenantId, { id: templateId }), data: { active: false } });
        }
        return { ...presentTemplate({ ...existing, active: false }), alreadyInactive: !existing.active };
    }, { tenantId });
}

// ── Letter context ───────────────────────────────────────────────────────────

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** The raw merge context for an offer (with candidate and jobRequisition loaded). */
export function buildLetterContext(offer, settings = {}) {
    const terms = asObject(offer?.terms);
    const compensation = asObject(offer?.compensation);
    return {
        candidate: { firstName: offer?.candidate?.firstName ?? null, lastName: offer?.candidate?.lastName ?? null },
        job: {
            title: terms.jobTitle || offer?.jobRequisition?.title || null,
            department: terms.department || null,
        },
        offer: {
            startDate: offer?.startDate ?? null,
            expiryDate: offer?.expiryDate ?? null,
            salary: compensation.baseSalary ?? offer?.salary ?? null,
            currency: compensation.currency || offer?.currency || null,
            employmentType: offer?.employmentType || offer?.jobRequisition?.employmentType || null,
            probationMonths: terms.probationMonths ?? null,
            noticePeriodDays: terms.noticePeriodDays ?? null,
            benefits: compensation.benefits ?? null,
        },
        company: { name: settings?.companyName ?? null },
    };
}

const candidateName = (candidate) =>
    [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" ").trim() || null;

export const letterContentHash = (rendered) =>
    crypto.createHash("sha256").update(`${rendered.subject ?? ""}\n\n${rendered.text}`, "utf8").digest("hex");

// ── Versions ─────────────────────────────────────────────────────────────────

/** Present a version; scopes without compensation get no media ids or hash. */
export function presentLetterVersion(row, scope = null, { isCurrent = false } = {}) {
    if (!row) return null;
    const masked = scope ? !scope.canSeeCompensation : false;
    return {
        id: row.id,
        offerId: row.offerId,
        version: row.version,
        templateKey: row.templateKey,
        templateVersion: row.templateVersion,
        mediaId: masked ? null : row.mediaId ?? null,
        contentHash: masked ? null : row.contentHash ?? null,
        renderedById: row.renderedById ?? null,
        createdAt: row.createdAt ?? null,
        signatureStatus: row.signatureStatus,
        esignProvider: row.esignProvider ?? null,
        sentForSignatureAt: row.sentForSignatureAt ?? null,
        signedAt: row.signedAt ?? null,
        signedMediaId: masked ? null : row.signedMediaId ?? null,
        signatureError: row.signatureError ?? null,
        isCurrent,
        ...(masked ? { mediaRedacted: true } : {}),
    };
}

/** The newest letter version of an offer, or null. */
export async function findNewestLetterVersion(db, tenantId, offerId) {
    return await db.offerLetterVersion.findFirst({
        where: withTenant(tenantId, { offerId: Number(offerId) }),
        orderBy: { version: "desc" },
    });
}

async function loadOfferInScope(tenantId, offerId, scope) {
    const offer = await prisma.offer.findFirst({
        where: withTenant(tenantId, { id: offerId, ...(scope ? offerScopeWhere(scope) : {}) }),
        include: { candidate: true, jobRequisition: true },
    });
    if (!offer) throw fail("Offer not found", 404, "HR-RECRUITMENT-OFFER-NOT-FOUND");
    return offer;
}

function assertRenderable(offer, newest) {
    if (CLOSED_OFFER_STATUSES.includes(offer.status)) {
        throw fail(`A letter cannot be rendered for a ${offer.status} offer`, 409, "HR-RECRUITMENT-OFFER-FINALIZED");
    }
    if (newest && LOCKED_SIGNATURE_STATUSES.includes(newest.signatureStatus)) {
        throw fail(
            `Letter version ${newest.version} is ${newest.signatureStatus}; void the signature request before rendering a new letter`,
            409,
            "HR-RECRUITMENT-OFFER-LETTER-OUT-FOR-SIGNATURE",
        );
    }
}

/**
 * Render the offer's letter. With preview: true nothing is stored and the
 * text is returned for the review screen; otherwise a new version is created.
 */
export async function renderOfferLetterVersion({
    tenantId,
    scope,
    offerId,
    templateKey = null,
    preview = false,
    actorId = null,
    now = new Date(),
} = {}) {
    requireTenant(tenantId);
    requireOfferLettersEnabled();
    requireCompensationScope(scope);
    const id = positiveId(offerId, "offer id");

    const offer = await loadOfferInScope(tenantId, id, scope);
    const newest = await findNewestLetterVersion(prisma, tenantId, id);
    assertRenderable(offer, newest);

    const template = await resolveOfferLetterTemplate({
        tenantId,
        key: templateKey ?? offer.offerType ?? DEFAULT_TEMPLATE_KEY,
        explicit: templateKey != null,
    });
    const settings = await getRecruitmentSettings({ tenantId });
    const values = buildMergeValues(buildLetterContext(offer, settings), { timeZone: settings.timeZone, now });
    const rendered = renderOfferLetter(template, values);
    const contentHash = letterContentHash(rendered);
    const templateInfo = { key: template.key, version: template.version, builtIn: Boolean(template.builtIn), name: template.name };

    if (preview) {
        return { preview: true, subject: rendered.subject, paragraphs: rendered.paragraphs, text: rendered.text, warnings: rendered.warnings, template: templateInfo };
    }

    if (
        newest &&
        newest.signatureStatus === "NONE" &&
        newest.mediaId &&
        newest.contentHash === contentHash &&
        newest.templateKey === template.key &&
        newest.templateVersion === template.version
    ) {
        return { version: presentLetterVersion(newest, scope, { isCurrent: true }), replayed: true, warnings: rendered.warnings, template: templateInfo };
    }

    // The PDF's CreationDate is the version's createdAt, so the row is
    // stamped with the same instant rather than the database default.
    const createdAt = new Date(now);
    const pdf = await generateOfferLetterPdf({
        companyName: settings.companyName ?? null,
        subject: rendered.subject,
        paragraphs: rendered.paragraphs,
        candidateName: candidateName(offer.candidate),
        createdAt,
    });
    const mediaId = await uploadOfferLetterPdf(pdf, `offer-${id}-letter-${contentHash.slice(0, 12)}.pdf`);

    const row = await tenantTransaction(prisma, async (tx) => {
        // Serialize renders (and the e-sign send) of one offer.
        await tx.$queryRaw`SELECT id FROM "offers" WHERE id=${id} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
        const current = await tx.offer.findFirst({ where: withTenant(tenantId, { id }), select: { id: true, status: true } });
        if (!current) throw fail("Offer not found", 404, "HR-RECRUITMENT-OFFER-NOT-FOUND");
        const latest = await findNewestLetterVersion(tx, tenantId, id);
        assertRenderable(current, latest);
        const created = await tx.offerLetterVersion.create({
            data: {
                tenantId,
                offerId: id,
                version: (latest?.version ?? 0) + 1,
                templateKey: template.key,
                templateVersion: template.version,
                mediaId,
                contentHash,
                renderedById: actorId ?? null,
                createdAt,
            },
        });
        await tx.offer.updateMany({ where: withTenant(tenantId, { id }), data: { offerLetterMediaId: mediaId } });
        await enqueueHrDomainEvent(tx, offerLetterRenderedEvent(created, eventContext({ actorId })));
        return created;
    }, { tenantId });

    return { version: presentLetterVersion(row, scope, { isCurrent: true }), replayed: false, warnings: rendered.warnings, template: templateInfo };
}

/** Every letter version of an offer, newest first, masked for the scope. */
export async function listOfferLetterVersions({ tenantId, scope, offerId } = {}) {
    requireTenant(tenantId);
    requireOfferLettersEnabled();
    const id = positiveId(offerId, "offer id");
    // Out-of-scope offers read as not found, like every offer read.
    const offer = await prisma.offer.findFirst({
        where: withTenant(tenantId, { id, ...(scope ? offerScopeWhere(scope) : {}) }),
        select: { id: true, status: true, offerLetterMediaId: true },
    });
    if (!offer) throw fail("Offer not found", 404, "HR-RECRUITMENT-OFFER-NOT-FOUND");
    const rows = await prisma.offerLetterVersion.findMany({
        where: withTenant(tenantId, { offerId: id }),
        orderBy: { version: "desc" },
        take: 100,
    });
    return {
        offerId: id,
        offerStatus: offer.status,
        items: rows.map((row, index) => presentLetterVersion(row, scope, { isCurrent: index === 0 })),
    };
}
