// src/lib/publicPortal.js
//
// Phase 5 / decision record §3.1–§3.4 — the PUBLIC careers-portal data layer.
//
// This is the boundary between "recruiter HR" and "the internet". Everything a
// candidate request can touch goes through these functions, and the invariants
// they enforce are:
//
//   * NO PII of anyone except the submitting candidate crosses the boundary —
//     job listings carry the requisition's publishable content, never the
//     hiring manager's name, never internal approval state, never rejection
//     reasons (§3.5a), never salary internals beyond the published grade.
//   * NO ENUMERATION. The decisions §3.4 rule ("do not reveal whether an email
//     exists") is applied to jobs as well: a closed or unknown requisition id
//     produces the SAME 404 shape, so ids cannot be probed.
//   * EVERYTHING is tenant-pinned. The portal is public but never cross-tenant;
//     the tenant comes from the portal host mapping (env config in this slice),
//     never from a candidate-supplied header.
//   * Eligibility is the SAME rule recruiters answer to (§2.9 via
//     evaluateRequisitionEligibility) — the public site cannot show a job the
//     internal gate would refuse an application against.
import { evaluateRequisitionEligibility, closedApplicationMessage } from "./requisitionEligibility.js";
import { JOB_CONTENT_SCHEMA_VERSION } from "./requisitionFields.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

// The ONLY fields of a requisition that may leave the building. Exported so a
// test can check every key against the generated Prisma datamodel: a select
// naming a field that does not exist fails only against a real database.
export const PUBLIC_JOB_SELECT = Object.freeze({
    id: true,
    title: true,
    status: true,
    location: true,
    employmentType: true,
    openings: true,
    closesAt: true,
    jobContent: true,
    // GradeLevel stores the band as minSalary / maxSalary (+ bandCurrency).
    // JobRequisition has no department relation: departmentId points at an
    // RBAC-owned department, so the public shape carries no department name.
    gradeLevel: { select: { name: true, minSalary: true, maxSalary: true, bandCurrency: true } },
    postings: {
        where: { isActive: true },
        select: { channel: true, externalUrl: true, isActive: true, closedAt: true },
    },
});

// Job content is a JSON column, so prisma filters cannot reach inside it; the
// text filter runs on the trimmed rows instead. Cheap at listing size and
// honest about what it searches (title + published content, nothing hidden).
const matchesSearch = (job, q) => {
    if (!q) return true;
    const needle = String(q).trim().toLowerCase();
    if (!needle) return true;
    if (String(job.title || "").toLowerCase().includes(needle)) return true;
    const content = job.jobContent && typeof job.jobContent === "object" ? job.jobContent : {};
    const haystack = [
        content.summary,
        ...(Array.isArray(content.skills) ? content.skills : []),
        ...(Array.isArray(content.responsibilities) ? content.responsibilities : []),
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    return haystack.includes(needle);
};

// Decimal band amounts leave as plain numbers (major units), or null.
const bandAmount = (value) => (value == null ? null : Number(value));

/** The public shape of one job. Nothing else may be added by a caller. */
export function toPublicJob(requisition, { now = new Date() } = {}) {
    const evaluation = evaluateRequisitionEligibility(requisition, { postings: requisition.postings ?? [], now });
    const content =
        requisition.jobContent && typeof requisition.jobContent === "object" ? requisition.jobContent : {};

    const publicShape = {
        id: requisition.id,
        title: requisition.title,
        location: requisition.location ?? null,
        employmentType: requisition.employmentType ?? null,
        openings: requisition.openings ?? 1,
        department: null,
        grade: requisition.gradeLevel
            ? {
                  name: requisition.gradeLevel.name,
                  min: bandAmount(requisition.gradeLevel.minSalary),
                  max: bandAmount(requisition.gradeLevel.maxSalary),
                  currency: requisition.gradeLevel.bandCurrency ?? null,
              }
            : null,
        closesAt: requisition.closesAt ? new Date(requisition.closesAt).toISOString() : null,
        // Published content only — the versioned structured schema from §1.3,
        // with the schema version surfaced so a rendering change is explicit.
        jobContent: {
            schemaVersion: content.schemaVersion ?? JOB_CONTENT_SCHEMA_VERSION,
            summary: content.summary ?? null,
            responsibilities: content.responsibilities ?? [],
            requirements: content.requirements ?? [],
            skills: content.skills ?? [],
            benefits: content.benefits ?? [],
            hiringProcess: content.hiringProcess ?? [],
            faq: content.faq ?? [],
        },
        // Which channels it is live on is public (the career site IS one);
        // the URLs are the ones recruiters recorded for this purpose.
        channels: (requisition.postings ?? []).map((p) => ({ channel: p.channel, externalUrl: p.externalUrl })),
        eligible: evaluation.eligible,
        // §2.9a — a closed job says so, in candidate language, with one reason.
        candidateMessage: evaluation.eligible ? null : closedApplicationMessage(requisition, evaluation),
    };
    return publicShape;
}

/**
 * List open jobs for one tenant's portal.
 *
 * Deliberately returns only ELIGIBLE jobs: the public listing is not a
 * diagnostic view, and a closed requisition that appears with a "closed" badge
 * is still an enumeration of internal activity. Closed jobs disappear from the
 * list and, if probed by id, 404 like anything else unknown.
 */
export async function listPublicJobs({ tenantId, prisma, q = null, now = new Date() }) {
    if (!tenantId) throw fail("Tenant context is required", 500, "HR-TENANT-REQUIRED");
    const requisitions = await prisma.jobRequisition.findMany({
        where: { tenantId, status: "POSTED" },
        select: PUBLIC_JOB_SELECT,
        orderBy: [{ closesAt: "asc" }, { id: "desc" }],
    });
    return requisitions
        .filter((r) => matchesSearch(r, q))
        .map((r) => toPublicJob(r, { now }))
        .filter((j) => j.eligible)
        // Strip the internal-only fields before the array leaves the boundary.
        .map(({ eligible: _eligible, candidateMessage: _message, ...openJob }) => openJob);
}

/**
 * One job's public detail. An unknown id, a closed job, another tenant's job —
 * all return null and the route renders them identically (§3.4 anti-enumeration).
 */
export async function getPublicJob({ tenantId, prisma, id, now = new Date() }) {
    if (!tenantId) throw fail("Tenant context is required", 500, "HR-TENANT-REQUIRED");
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const requisition = await prisma.jobRequisition.findFirst({
        where: { id: numericId, tenantId, status: "POSTED" },
        select: PUBLIC_JOB_SELECT,
    });
    if (!requisition) return null;
    const publicJob = toPublicJob(requisition, { now });
    if (!publicJob.eligible) return null;
    // The detail shape is the listing shape minus the two internal-only fields
    // (evaluated above via `eligible`, stripped here via rest destructure).
    const openJob = { ...publicJob };
    delete openJob.eligible;
    delete openJob.candidateMessage;
    return openJob;
}

// ── Public application intake (§3.2/§3.5) ───────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate the public application payload. Deliberately hand-rolled rather than
 * zod-in-a-lib: the portal is the one surface where a validation error message
 * is a fingerprint (an over-specific rejection tells a bot which fields the
 * backend keeps), so the checks are generic and the error text is uniform.
 */
export function parsePublicApplicationInput(body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw fail("Invalid application", 400, "HR-PORTAL-INPUT-INVALID");
    }
    const firstName = String(body.firstName ?? "").trim();
    const lastName = String(body.lastName ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const phone = String(body.phone ?? "").trim();

    if (!firstName || !email || !EMAIL_RE.test(email)) {
        throw fail("Invalid application", 400, "HR-PORTAL-INPUT-INVALID");
    }
    if (phone && !/^[+\d][\d\s()-]{5,19}$/.test(phone)) {
        throw fail("Invalid application", 400, "HR-PORTAL-INPUT-INVALID");
    }

    const answers = body.answers;
    if (answers !== undefined && (typeof answers !== "object" || Array.isArray(answers))) {
        throw fail("Invalid application", 400, "HR-PORTAL-INPUT-INVALID");
    }

    return {
        firstName,
        lastName: lastName || null,
        email,
        phone: phone || null,
        // §3.3 — the caller must state WHICH policy document the candidate saw.
        // A version invented by the backend would be a lie in an audit.
        policyVersion: String(body.policyVersion ?? "").trim() || null,
        answers: answers && typeof answers === "object" ? answers : null,
        source: String(body.source ?? "PORTAL").trim().toUpperCase() || "PORTAL",
    };
}
