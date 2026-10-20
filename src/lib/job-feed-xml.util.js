// src/lib/job-feed-xml.util.js
//
// Phase 2 — the XML document behind the per-tenant job board feed.
//
// Indeed's XML feed shape (`<source>` with a `<job>` per listing) is the de
// facto format job boards ingest, LinkedIn's limited listings feed included, so
// one builder serves both channels; the service decides which jobs go in and
// which apply URL each one carries.
//
// Pure functions, no I/O and no XML dependency. The document is small and fully
// controlled here, so three rules keep it well formed whatever a recruiter
// typed into a job:
//   * every text value goes out as CDATA, with any "]]>" inside it split
//     across two CDATA sections (the only sequence CDATA cannot carry);
//   * characters XML 1.0 forbids (most C0 controls, lone surrogates, U+FFFE/F)
//     are dropped first, since no escaping makes them legal;
//   * element names are fixed literals in this file, never data.

// XML 1.0 §2.2 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
// Checked per code point rather than with a regex so no control character has
// to be written into a pattern.
const isXmlChar = (cp) =>
    cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0x10ffff);

/** Drop every character XML 1.0 cannot carry. Null/undefined become "". */
export function stripInvalidXmlChars(value) {
    if (value === undefined || value === null) return "";
    let out = "";
    // for..of walks code points, so a valid surrogate pair stays whole and a
    // lone surrogate arrives as its own (invalid) code point.
    for (const ch of String(value)) {
        if (isXmlChar(ch.codePointAt(0))) out += ch;
    }
    return out;
}

/** Escape text for an XML (or HTML) text node or attribute value. */
export function escapeXmlText(value) {
    return stripInvalidXmlChars(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

/**
 * Wrap text in CDATA. A "]]>" in the content would end the section early, so
 * it is split as "]]" + "]]><![CDATA[" + ">": the parser joins the sections
 * back into the original characters.
 */
export function cdata(value) {
    const clean = stripInvalidXmlChars(value).replaceAll("]]>", "]]]]><![CDATA[>");
    return `<![CDATA[${clean}]]>`;
}

const element = (name, value) => `<${name}>${cdata(value)}</${name}>`;
const optionalElement = (name, value) =>
    value === undefined || value === null || String(value).trim() === "" ? "" : element(name, value);

// Indeed's jobtype vocabulary for the requisition's EMPLOYMENT_TYPES.
const JOB_TYPES = Object.freeze({
    FULL_TIME: "fulltime",
    PART_TIME: "parttime",
    CONTRACT: "contract",
    INTERN: "internship",
    TEMPORARY: "temporary",
});

/** The feed's jobtype for an employment type, or null when it has none. */
export function feedJobType(employmentType) {
    return JOB_TYPES[String(employmentType ?? "").trim().toUpperCase()] ?? null;
}

/**
 * Split the requisition's free-text location into the feed's city / state /
 * country. The column is free text ("Lahore", "Lahore, Pakistan",
 * "Lahore, Punjab, Pakistan"), so the rule is positional: the first part is the
 * city, a last part after it is the country, and a middle part is the state.
 */
export function splitLocation(location) {
    const parts = String(location ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    if (!parts.length) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    if (parts.length === 2) return { city: parts[0], state: null, country: parts[1] };
    return { city: parts[0], state: parts.slice(1, -1).join(", "), country: parts[parts.length - 1] };
}

const DESCRIPTION_SECTIONS = Object.freeze([
    ["responsibilities", "Responsibilities"],
    ["requirements", "Requirements"],
    ["skills", "Skills"],
    ["benefits", "Benefits"],
]);

/**
 * The job description as simple HTML, built from the requisition's published
 * jobContent only (the same content the careers portal shows). Every value is
 * HTML-escaped: job boards render the description as HTML.
 */
export function buildJobDescriptionHtml(jobContent) {
    const content = jobContent && typeof jobContent === "object" && !Array.isArray(jobContent) ? jobContent : {};
    const blocks = [];
    if (content.summary && String(content.summary).trim()) {
        blocks.push(`<p>${escapeXmlText(String(content.summary).trim())}</p>`);
    }
    for (const [key, heading] of DESCRIPTION_SECTIONS) {
        const items = (Array.isArray(content[key]) ? content[key] : [])
            .map((item) => String(item ?? "").trim())
            .filter(Boolean);
        if (!items.length) continue;
        const list = items.map((item) => `<li>${escapeXmlText(item)}</li>`).join("");
        blocks.push(`<h3>${heading}</h3><ul>${list}</ul>`);
    }
    return blocks.join("");
}

const toFeedDate = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toUTCString();
};

function jobXml(job) {
    return [
        "<job>",
        element("title", job.title),
        element("date", toFeedDate(job.date)),
        element("referencenumber", job.referenceNumber),
        element("url", job.url),
        element("company", job.company),
        optionalElement("city", job.city),
        optionalElement("state", job.state),
        optionalElement("country", job.country),
        element("description", job.description),
        optionalElement("jobtype", job.jobType),
        optionalElement("category", job.category),
        "</job>",
    ].join("");
}

/**
 * Build the whole feed document.
 *
 * @param {object} args
 * @param {string|null} args.publisher      employer name
 * @param {string|null} args.publisherUrl   employer site
 * @param {Date} args.lastBuildDate
 * @param {Array<{ title, date, referenceNumber, url, company, city?, state?, country?, description, jobType?, category? }>} args.jobs
 * @returns {string}
 */
export function buildJobFeedXml({ publisher = null, publisherUrl = null, lastBuildDate = new Date(), jobs = [] } = {}) {
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<source>",
        element("publisher", publisher ?? ""),
        element("publisherurl", publisherUrl ?? ""),
        element("lastBuildDate", toFeedDate(lastBuildDate)),
        ...jobs.map(jobXml),
        "</source>",
        "",
    ].join("\n");
}
