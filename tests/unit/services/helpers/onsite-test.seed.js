// tests/unit/services/helpers/onsite-test.seed.js
//
// One tenant's interview day for the Phase 3b tests: a requisition, a
// candidate with an application at the interview stage, an assessment
// interview at the Lahore office, three kiosks, a published blueprint with a
// must-pass safety section, and an item pool deep enough to draw from.
export const TENANT = "11111111-1111-4111-8111-111111111111";
export const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

export const ROLES = Object.freeze({
    recruiter: { tenantId: TENANT, roles: ["RECRUITER"], employeeId: 1 },
    reception: { tenantId: TENANT, roles: ["RECEPTION"], employeeId: 50 },
    panelist: { tenantId: TENANT, roles: ["INTERVIEWER"], employeeId: 3 },
    outsider: { tenantId: TENANT, roles: ["INTERVIEWER"], employeeId: 99 },
    manager: { tenantId: TENANT, roles: ["HIRING_MANAGER"], employeeId: 7 },
});

export const BLUEPRINT_SECTIONS = Object.freeze([
    { key: "domain", label: "Domain knowledge", competencyKey: "DOMAIN", itemCount: 4, difficultyMix: { EASY: 25, MEDIUM: 50, HARD: 25 }, mustPass: false },
    { key: "safety", label: "Safety rules", competencyKey: "SAFETY", itemCount: 2, difficultyMix: { EASY: 50, MEDIUM: 50, HARD: 0 }, mustPass: true, sectionPassMarkPct: 50 },
]);

const OPTIONS = [
    { id: "a", text: "Alpha", feedback: "author note a" },
    { id: "b", text: "Bravo", feedback: "author note b" },
    { id: "c", text: "Charlie" },
    { id: "d", text: "Delta" },
];

let itemSeq = 0;
export function addItem(db, over = {}) {
    itemSeq += 1;
    const row = {
        id: 1000 + itemSeq,
        tenantId: TENANT,
        itemCode: `IT-${itemSeq}`,
        version: 1,
        status: "PUBLISHED",
        type: "SINGLE",
        stem: `Question ${itemSeq}`,
        mediaId: null,
        options: OPTIONS,
        answerKey: JSON.stringify({ optionIds: ["a"] }),
        scoringRule: null,
        difficulty: "EASY",
        competencyKey: "DOMAIN",
        jobFamily: "Eng",
        language: "en",
        rationale: "Because alpha is right",
        discussionPrompt: false,
        exposureCount: 0,
        exposureCap: null,
        ...over,
    };
    db.rows("candidateTestItem").push(row);
    return row;
}

export function seedOnsite(db, { blueprint = {}, interview = {}, settings = null } = {}) {
    for (const key of Object.keys(db.state.tables)) delete db.state.tables[key];
    db.state.ops.length = 0;
    itemSeq = 0;
    const now = new Date();
    db.rows("jobRequisition").push({ id: 21, tenantId: TENANT, title: "Plant Engineer", requestedById: 7, approvedById: null });
    db.rows("candidate").push({ id: 5, tenantId: TENANT, firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com" });
    db.rows("candidate").push({ id: 6, tenantId: TENANT, firstName: "Bilal", lastName: null, email: "bilal@example.com" });
    db.rows("application").push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "interview", sourceChannel: "REFERRAL" });
    db.rows("application").push({ id: 10, tenantId: TENANT, candidateId: 6, jobRequisitionId: 21, stage: "interview", sourceChannel: "CAREER_SITE" });
    db.rows("interview").push({
        id: 40,
        tenantId: TENANT,
        applicationId: 9,
        interviewType: "ONSITE",
        scheduledAt: new Date(now.getTime() + 60 * 60 * 1000),
        durationMinutes: 45,
        location: "Lahore office, room 2",
        status: "SCHEDULED",
        assessmentRequired: true,
        assessmentStatus: "REQUIRED",
        assessmentBlueprintId: 70,
        ...interview,
    });
    db.rows("interview").push({
        id: 41,
        tenantId: TENANT,
        applicationId: 10,
        interviewType: "ONSITE",
        scheduledAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        durationMinutes: 45,
        location: "Karachi office",
        status: "SCHEDULED",
        assessmentRequired: true,
        assessmentStatus: "REQUIRED",
        assessmentBlueprintId: 70,
    });
    db.rows("interviewInterviewer").push({ interviewId: 40, employeeId: 3, tenantId: TENANT }, { interviewId: 40, employeeId: 4, tenantId: TENANT });
    db.rows("testWorkstation").push(
        { id: 80, tenantId: TENANT, label: "Kiosk 1", siteRef: "Lahore", status: "ACTIVE" },
        { id: 81, tenantId: TENANT, label: "Kiosk 2", siteRef: "Lahore", status: "ACTIVE" },
        { id: 82, tenantId: TENANT, label: "Kiosk K", siteRef: "Karachi", status: "ACTIVE" },
        { id: 83, tenantId: TENANT, label: "Old kiosk", siteRef: "Lahore", status: "REVOKED" },
    );
    db.rows("candidateTestBlueprint").push({
        id: 70,
        tenantId: TENANT,
        blueprintKey: "ENG-ONSITE",
        version: 2,
        name: "Plant engineer on-site test",
        status: "PUBLISHED",
        language: "en",
        jobFamily: "ENG",
        durationMin: 30,
        passMarkPct: 60,
        borderlineBandPct: 10,
        hardFloorPct: null,
        autoReleaseBelowFloor: false,
        negativeMarking: false,
        negativeMarkFraction: null,
        navigation: "FREE",
        flagForReview: true,
        sections: BLUEPRINT_SECTIONS,
        resultValidityDays: 90,
        integrityFlagThreshold: 2,
        maxExtraTimePct: 50,
        allowAnySiteKiosk: false,
        ...blueprint,
    });
    if (settings) db.rows("tenantRecruitmentSettings").push({ tenantId: TENANT, timeZone: "Asia/Karachi", kioskShowScore: false, ...settings });

    // DOMAIN: 3 easy, 4 medium, 3 hard; SAFETY: 3 easy, 3 medium.
    for (const difficulty of ["EASY", "EASY", "EASY", "MEDIUM", "MEDIUM", "MEDIUM", "MEDIUM", "HARD", "HARD", "HARD"]) {
        addItem(db, { difficulty, competencyKey: "DOMAIN" });
    }
    for (const difficulty of ["EASY", "EASY", "EASY", "MEDIUM", "MEDIUM", "MEDIUM"]) {
        addItem(db, { difficulty, competencyKey: "SAFETY" });
    }
    return { now };
}

/** The interview row (live reference into the fake). */
export const interviewOf = (db, id = 40) => db.rows("interview").find((i) => i.id === id);
export const sessionOf = (db, id) => db.rows("candidateTestSession").find((s) => s.id === id);
