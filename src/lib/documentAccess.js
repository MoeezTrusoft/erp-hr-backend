// src/lib/documentAccess.js
//
// Phase 6 / decision record §4.4 — the DOCUMENT ACCESS MATRIX.
//
// One pure module so the matrix cannot drift between the recruiter surface,
// the interviewer packet view, the requisition-attachment endpoints and any
// future candidate-facing surface. Everything here fails CLOSED: an unknown
// audience or an unknown document class is a refusal, never a default-allow.
//
// The rule the decision names, in one line: document type and ACL are
// INDEPENDENT. Interviewers do NOT get broad candidate-document access merely
// by being assigned an interview — a document reaches an interviewer's view
// because a packet row exists for it (and only for classes the matrix permits
// in a packet), not because of who they are.
//
// The matrix (verbatim cells from the decision record):
//
//   | Document                        | Recruiter/HR  | Hiring Manager     | Assigned interviewer              | Candidate |
//   |---------------------------------|---------------|--------------------|-----------------------------------|-----------|
//   | Resume/CV                       | Yes           | Yes                | Yes, while assigned               | Own only  |
//   | Portfolio                       | Yes           | Yes                | Yes, if in the interview packet   | Own only  |
//   | General application documents   | Yes           | Yes                | Only if explicitly interview-visible | Own only |
//   | Screening notes                 | Yes           | Authorized manager | No                                | No        |
//   | Interview brief                 | Yes           | Yes                | Yes                               | No        |
//   | Interview feedback              | Yes           | Authorized manager | Own feedback / policy panel view  | No        |
//   | Budget/approval documents       | Authorized only | If permitted     | No                                | No        |
//   | Offer/internal approval docs    | Authorized only | If approver      | No                                | No        |
//   | Candidate offer letter          | Yes           | If permitted       | No                                | Yes       |
//
// The matrix answers "may this AUDIENCE see this CLASS at all?" — the row-level
// scoping inside an allowed cell ("while assigned", "own only", "if in the
// packet") is the caller's job, because only the caller knows the viewer's
// concrete relationship to the requisition. The matrix deliberately refuses to
// guess it.

/**
 * The audiences the matrix speaks about. RECRUITER covers HR/recruiting users
 * by permission; the finer cells ("authorized only", "if approver") are
 * refined by capability checks at the call site — the matrix's job is to make
 * sure nobody slips in through an audience that plainly cannot see the class.
 */
export const AUDIENCES = {
    RECRUITER: "RECRUITER",
    HIRING_MANAGER: "HIRING_MANAGER",
    INTERVIEWER: "INTERVIEWER",
    CANDIDATE: "CANDIDATE",
};

/**
 * The document classes the matrix governs. RESUME is the candidate's CV asset
 * (Candidate.resumeMediaId); INTERVIEW_FEEDBACK and SCREENING_NOTES are
 * records, not DAM assets — they appear here so the matrix can refuse them as
 * packet content and so a future record-view surface reuses the same table.
 */
export const DOC_CLASSES = {
    RESUME: "RESUME",
    PORTFOLIO: "PORTFOLIO",
    GENERAL_APPLICATION_DOC: "GENERAL_APPLICATION_DOC",
    SCREENING_NOTES: "SCREENING_NOTES",
    INTERVIEW_BRIEF: "INTERVIEW_BRIEF",
    INTERVIEW_FEEDBACK: "INTERVIEW_FEEDBACK",
    BUDGET_APPROVAL: "BUDGET_APPROVAL",
    OFFER_APPROVAL: "OFFER_APPROVAL",
    OFFER_LETTER: "OFFER_LETTER",
};

// The matrix itself. `true` = the audience may see the class (subject to the
// row-level scoping the caller applies); `false` = never. Anything not listed
// fails closed via canAccess.
const MATRIX = {
    [DOC_CLASSES.RESUME]: {
        [AUDIENCES.RECRUITER]: true,
        [AUDIENCES.HIRING_MANAGER]: true,
        [AUDIENCES.INTERVIEWER]: true, // "while assigned" — caller must scope
        [AUDIENCES.CANDIDATE]: true, // "own only" — caller must scope
    },
    [DOC_CLASSES.PORTFOLIO]: {
        [AUDIENCES.RECRUITER]: true,
        [AUDIENCES.HIRING_MANAGER]: true,
        [AUDIENCES.INTERVIEWER]: true, // "if in the interview packet"
        [AUDIENCES.CANDIDATE]: true, // "own only"
    },
    [DOC_CLASSES.GENERAL_APPLICATION_DOC]: {
        [AUDIENCES.RECRUITER]: true,
        [AUDIENCES.HIRING_MANAGER]: true,
        [AUDIENCES.INTERVIEWER]: true, // "only if explicitly interview-visible" = packet row
        [AUDIENCES.CANDIDATE]: true, // "own only"
    },
    [DOC_CLASSES.SCREENING_NOTES]: {
        [AUDIENCES.RECRUITER]: true,
        [AUDIENCES.HIRING_MANAGER]: true, // "authorized manager" — caller refines
        [AUDIENCES.INTERVIEWER]: false,
        [AUDIENCES.CANDIDATE]: false,
    },
    [DOC_CLASSES.INTERVIEW_BRIEF]: {
        [AUDIENCES.RECRUITER]: true,
        [AUDIENCES.HIRING_MANAGER]: true,
        [AUDIENCES.INTERVIEWER]: true, // yes — the one class that needs no packet row
        [AUDIENCES.CANDIDATE]: false,
    },
    [DOC_CLASSES.INTERVIEW_FEEDBACK]: {
        [AUDIENCES.RECRUITER]: true,
        [AUDIENCES.HIRING_MANAGER]: true, // "authorized manager" — caller refines
        [AUDIENCES.INTERVIEWER]: true, // "own feedback / policy panel view" — caller scopes
        [AUDIENCES.CANDIDATE]: false,
    },
    [DOC_CLASSES.BUDGET_APPROVAL]: {
        [AUDIENCES.RECRUITER]: true, // "authorized only" — caller refines
        [AUDIENCES.HIRING_MANAGER]: true, // "if permitted" — caller refines
        [AUDIENCES.INTERVIEWER]: false,
        [AUDIENCES.CANDIDATE]: false,
    },
    [DOC_CLASSES.OFFER_APPROVAL]: {
        [AUDIENCES.RECRUITER]: true, // "authorized only"
        [AUDIENCES.HIRING_MANAGER]: true, // "if approver"
        [AUDIENCES.INTERVIEWER]: false,
        [AUDIENCES.CANDIDATE]: false,
    },
    [DOC_CLASSES.OFFER_LETTER]: {
        [AUDIENCES.RECRUITER]: true,
        [AUDIENCES.HIRING_MANAGER]: true, // "if permitted" — caller refines
        [AUDIENCES.INTERVIEWER]: false,
        [AUDIENCES.CANDIDATE]: true, // "yes" — the candidate owns it
    },
};

/** May this audience see this document class at all? Unknown inputs refuse. */
export function canAccess(docClass, audience) {
    const row = MATRIX[docClass];
    if (!row) return false;
    return row[audience] === true;
}

/**
 * May this class be added to an interview packet at all?
 *
 * The packet exists to hand a candidate's material to assigned interviewers.
 * Only the classes whose interviewer cell is a packet-conditioned yes
 * qualify — plus INTERVIEW_BRIEF, which interviewers may always see, so
 * packeting it is allowed (it is how a brief with attachments is distributed)
 * but never required. Screening notes, feedback, budget/approval and offer
 * documents can NEVER be packeted: no caller, no flag, no exception.
 */
export const PACKETABLE_CLASSES = [
    DOC_CLASSES.PORTFOLIO,
    DOC_CLASSES.GENERAL_APPLICATION_DOC,
    DOC_CLASSES.INTERVIEW_BRIEF,
];

export function isPacketable(docClass) {
    return PACKETABLE_CLASSES.includes(docClass);
}

/**
 * Does this class reach an interviewer through a PACKET ROW, as opposed to
 * being composed from elsewhere?
 *
 *   * PORTFOLIO / GENERAL_APPLICATION_DOC — yes: the row IS the
 *     "explicitly interview-visible" switch the matrix speaks of.
 *   * RESUME — no: it rides on the assignment itself, sourced from the
 *     candidate's record (resumeMediaId), never packeted.
 *   * INTERVIEW_BRIEF — no: visible to assigned interviewers outright; a row
 *     merely packages it (with attachments).
 *   * Everything else — no, and it cannot be packeted at all.
 */
const PACKET_ROW_CLASSES = [DOC_CLASSES.PORTFOLIO, DOC_CLASSES.GENERAL_APPLICATION_DOC];

export function requiresPacketRow(docClass) {
    return PACKET_ROW_CLASSES.includes(docClass);
}

/**
 * Resolve what one viewer may see in ONE interview's packet.
 *
 * @param {object} ctx  Viewer context: { audience, isAssignedInterviewer }
 *   - audience: one of AUDIENCES
 *   - isAssignedInterviewer: the viewer has an InterviewInterviewer row on
 *     this interview. Meaningful only for the INTERVIEWER audience — it is
 *     the "while assigned" condition, and the packet view refuses an
 *     interviewer who lost or never had the assignment.
 * @param {object[]} packetItems  Packet rows for the interview, each with a
 *   docClass.
 * @returns {{ visible: object[], deniedClasses: string[] }}
 *   visible = packet items this viewer may open; deniedClasses = distinct
 *   classes present in the packet but not visible to this viewer (for audit
 *   logging; the response must never name the denied items' content).
 */
export function resolvePacketView(ctx, packetItems) {
    const { audience, isAssignedInterviewer = false } = ctx || {};

    if (audience === AUDIENCES.CANDIDATE) {
        // The packet is an INTERNAL view and never a candidate surface. The
        // matrix's candidate cells ("own only", the offer letter) are resolved
        // by ownership-scoped candidate surfaces with their own checks — never
        // by handing the shared packet to a candidate context.
        return { visible: [], deniedClasses: distinctClasses(packetItems) };
    }

    if (audience === AUDIENCES.INTERVIEWER && !isAssignedInterviewer) {
        // Fail closed: an interviewer audience without the assignment row sees
        // nothing, even classes whose matrix cell is "yes".
        return { visible: [], deniedClasses: distinctClasses(packetItems) };
    }

    const visible = [];
    for (const item of packetItems || []) {
        if (canAccess(item.docClass, audience)) visible.push(item);
    }
    const visibleIds = new Set(visible.map((i) => i.id));
    const deniedClasses = distinctClasses((packetItems || []).filter((i) => !visibleIds.has(i.id)));
    return { visible, deniedClasses };
}

function distinctClasses(items) {
    return [...new Set((items || []).map((i) => i.docClass))].sort();
}

/** Human-readable vocabulary for error messages and MCP schemas. */
export const DOC_CLASS_VALUES = Object.values(DOC_CLASSES);
