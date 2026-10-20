// src/lib/prohibited-topics.util.js
//
// Recruitment Phase 3b — the prohibited-topic check on interview notes (plan
// 7.4.4): free text is scanned for references to protected characteristics
// (age, marital status, pregnancy and family plans, religion, disability,
// caste or ethnicity, political affiliation) in English and in the common
// romanised Urdu forms.
//
// The rules:
//   * FLAG, NEVER BLOCK. The result is stored on the scorecard and routed to
//     HR; the submission always goes through.
//   * The terms found are for HR only. They are never echoed to the candidate,
//     and the outbox event carries ids, never the text or the terms.
//   * Whole words only, so "agenda", "stage", "average" or "Umar" (a name) do
//     not match; Urdu terms that are also everyday words or names are matched
//     as phrases ("kitni umar", "shadi shuda").
//   * A few benign phrases that contain a listed word are masked first (a
//     marriage counselling service, the HTTP max-age header, a race condition).
//
// Pure functions only.

const CATEGORIES = Object.freeze({
    AGE: [
        "age", "aged", "how old", "years old", "date of birth", "birth year", "too old", "too young", "retirement age",
        "kitni umar", "umar kitni", "kitni umr", "umr kitni", "umar zyada", "umar ziada", "zyada umar", "umar kam", "kam umar",
        "budha", "boodha", "burha", "budhi",
    ],
    MARITAL_STATUS: [
        "married", "unmarried", "marital", "marital status", "spouse", "husband", "wife", "divorced", "divorce", "widow",
        "widowed", "widower", "fiance", "fiancee", "engaged to", "single mother", "single father", "single parent",
        "shadi", "shaadi", "shadi shuda", "shaadi shuda", "ghair shadi shuda", "biwi", "shohar", "shauhar", "talaq",
        "mangni", "rishta",
    ],
    PREGNANCY_FAMILY: [
        "pregnant", "pregnancy", "maternity", "expecting a baby", "baby on the way", "planning a family", "family planning",
        "plan to have children", "have children", "has children", "has kids", "how many children", "how many kids", "childcare",
        "hamila", "hamal", "umeed se hai", "umeed se hain", "bachay", "bachey", "bachche", "bache",
    ],
    RELIGION: [
        "religion", "religious", "muslim", "christian", "hindu", "sikh", "ahmadi", "qadiani", "shia", "sunni", "parsi", "jewish",
        "atheist", "mosque", "church", "temple", "namaz", "namaaz", "roza", "rozay", "masjid", "mandir", "hijab", "burqa",
        "firqa", "maslak", "mazhab", "mazhabi",
    ],
    DISABILITY: ["disabled", "disability", "handicapped", "wheelchair", "mazoor", "mazur", "mazoori"],
    ETHNICITY_CASTE: ["ethnicity", "ethnic", "racial", "caste", "biradari", "baradari", "zaat", "qoum", "qaum"],
    POLITICAL: ["political party", "political affiliation", "votes for", "siyasi jamaat"],
});

// Benign phrases masked before matching: they contain a listed word but are
// not about the candidate.
const BENIGN_PHRASES = Object.freeze([
    "marriage counselling", "marriage counseling", "marriage and family therapy",
    "max-age", "max age", "cache age", "page age", "age of the data", "age of the cache",
    "race condition", "race conditions",
]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (term) => term.split(/\s+/).map(escape).join("[\\s-]+");

// One compiled matcher per term: whole words, case-insensitive.
const MATCHERS = Object.entries(CATEGORIES).flatMap(([category, terms]) =>
    terms.map((term) => ({ category, term, re: new RegExp(`(^|[^\\p{L}\\p{N}])${phrase(term)}(?=$|[^\\p{L}\\p{N}])`, "iu") })),
);
const BENIGN_RE = new RegExp(BENIGN_PHRASES.map(phrase).join("|"), "giu");

export const PROHIBITED_TOPIC_CATEGORIES = Object.freeze(Object.keys(CATEGORIES));

/**
 * Scan one or more free-text values.
 *
 * @param {...(string|null|undefined|string[])} texts
 * @returns {{ flagged: boolean, categories: string[], terms: string[] }}
 *   `terms` are "CATEGORY:term" entries for HR; never show them to a candidate.
 */
export function scanProhibitedTopics(...texts) {
    const body = texts
        .flat()
        .filter((t) => typeof t === "string" && t.trim())
        .join("\n")
        .replace(BENIGN_RE, " ");
    if (!body.trim()) return { flagged: false, categories: [], terms: [] };
    const terms = new Set();
    const categories = new Set();
    for (const { category, term, re } of MATCHERS) {
        if (re.test(body)) {
            terms.add(`${category}:${term}`);
            categories.add(category);
        }
    }
    return { flagged: terms.size > 0, categories: [...categories].sort(), terms: [...terms].sort() };
}
