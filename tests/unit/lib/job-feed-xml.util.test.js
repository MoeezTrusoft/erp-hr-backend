// Phase 2 job feed: the XML builder must produce a well-formed document
// whatever a recruiter typed (CDATA terminators, markup, control characters).
import { describe, it, expect } from "@jest/globals";

import {
    buildJobDescriptionHtml,
    buildJobFeedXml,
    cdata,
    escapeXmlText,
    feedJobType,
    splitLocation,
    stripInvalidXmlChars,
} from "../../../src/lib/job-feed-xml.util.js";

// A minimal well-formedness check: walks the document, skipping CDATA, and
// requires balanced tags, no stray "<", only known entities, and no character
// XML 1.0 forbids. Returns the decoded text of every CDATA section in order.
function checkWellFormed(xml) {
    let rest = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
    const stack = [];
    const cdataText = [];
    let current = null;
    while (rest.length) {
        if (rest.startsWith("<![CDATA[")) {
            const end = rest.indexOf("]]>");
            if (end < 0) throw new Error("unterminated CDATA");
            const piece = rest.slice(9, end);
            current = current === null ? piece : current + piece;
            rest = rest.slice(end + 3);
            // Adjacent sections belong to one value (the "]]>" split).
            if (!rest.startsWith("<![CDATA[")) {
                cdataText.push(current);
                current = null;
            }
            continue;
        }
        if (rest.startsWith("</")) {
            const m = /^<\/([A-Za-z][\w]*)>/.exec(rest);
            if (!m) throw new Error(`bad close tag near ${rest.slice(0, 20)}`);
            if (stack.pop() !== m[1]) throw new Error(`unbalanced </${m[1]}>`);
            rest = rest.slice(m[0].length);
            continue;
        }
        if (rest.startsWith("<")) {
            const m = /^<([A-Za-z][\w]*)>/.exec(rest);
            if (!m) throw new Error(`bad open tag near ${rest.slice(0, 20)}`);
            stack.push(m[1]);
            rest = rest.slice(m[0].length);
            continue;
        }
        const next = rest.indexOf("<");
        const chunk = next < 0 ? rest : rest.slice(0, next);
        if (/&(?!(amp|lt|gt|quot|apos);)/.test(chunk)) throw new Error("bare ampersand");
        rest = next < 0 ? "" : rest.slice(next);
    }
    if (stack.length) throw new Error(`unclosed <${stack.join(">, <")}>`);
    for (const ch of xml) {
        const cp = ch.codePointAt(0);
        const ok = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff)
            || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
        if (!ok) throw new Error(`invalid character U+${cp.toString(16)}`);
    }
    return cdataText;
}

const JOB = {
    title: "Engineer <Senior> & Lead ]]> now",
    date: new Date("2026-10-01T09:00:00Z"),
    referenceNumber: "42",
    url: "https://careers.acme.test/jobs/42?source=INDEED&posting=7",
    company: "Acme & Sons",
    city: "Lahore",
    state: "Punjab",
    country: "Pakistan",
    description: "<p>Build things</p>",
    jobType: "fulltime",
};

describe("job feed XML escaping", () => {
    it("escapes &, <, >, quotes for text nodes", () => {
        expect(escapeXmlText(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
    });

    it("splits ]]> inside CDATA so the section cannot end early", () => {
        const out = cdata("x]]>y");
        expect(out).toBe("<![CDATA[x]]]]><![CDATA[>y]]>");
        expect(checkWellFormed(`<a>${out}</a>`)).toEqual(["x]]>y"]);
    });

    it("drops characters XML 1.0 forbids and keeps tab, newline and astral characters", () => {
        const raw = `a\u0000b\u0008c\u000bd\u001fe\tf\ng￾h\uD800i\u{1F600}`;
        expect(stripInvalidXmlChars(raw)).toBe("abcde\tf\nghi\u{1F600}");
        expect(stripInvalidXmlChars(null)).toBe("");
    });
});

describe("buildJobFeedXml", () => {
    it("renders the Indeed source shape and stays well formed with hostile text", () => {
        const xml = buildJobFeedXml({
            publisher: "Acme & Sons",
            publisherUrl: "https://acme.test",
            lastBuildDate: new Date("2026-10-20T00:00:00Z"),
            jobs: [{ ...JOB, description: "bad\u0001 ]]> <script>" }],
        });
        expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
        const texts = checkWellFormed(xml);
        expect(texts).toContain("Engineer <Senior> & Lead ]]> now");
        expect(texts).toContain("bad ]]> <script>");
        expect(texts).toContain("Tue, 20 Oct 2026 00:00:00 GMT");
        for (const tag of ["publisher", "publisherurl", "lastBuildDate", "job", "title", "date", "referencenumber", "url", "company", "city", "state", "country", "description", "jobtype"]) {
            expect(xml).toContain(`<${tag}>`);
        }
        expect(xml).not.toContain("\u0001");
    });

    it("omits optional elements that have no value and renders an empty feed", () => {
        const xml = buildJobFeedXml({
            jobs: [{ ...JOB, city: null, state: null, country: null, jobType: null }],
        });
        checkWellFormed(xml);
        expect(xml).not.toContain("<city>");
        expect(xml).not.toContain("<jobtype>");
        expect(xml).not.toContain("<category>");

        const empty = buildJobFeedXml({ publisher: null, jobs: [] });
        checkWellFormed(empty);
        expect(empty).not.toContain("<job>");
        expect(empty).toContain("<publisher><![CDATA[]]></publisher>");
    });
});

describe("job content helpers", () => {
    it("builds an escaped HTML description from published jobContent only", () => {
        const html = buildJobDescriptionHtml({
            summary: "Lead <b>the</b> team & ship",
            responsibilities: ["Own ]]> delivery", ""],
            requirements: [],
            skills: ["Node.js"],
            internalNote: "never shown",
        });
        expect(html).toBe(
            "<p>Lead &lt;b&gt;the&lt;/b&gt; team &amp; ship</p>"
            + "<h3>Responsibilities</h3><ul><li>Own ]]&gt; delivery</li></ul>"
            + "<h3>Skills</h3><ul><li>Node.js</li></ul>",
        );
        expect(html).not.toContain("never shown");
        expect(buildJobDescriptionHtml(null)).toBe("");
    });

    it("maps employment types and splits free-text locations", () => {
        expect(feedJobType("FULL_TIME")).toBe("fulltime");
        expect(feedJobType("intern")).toBe("internship");
        expect(feedJobType("SOMETHING")).toBeNull();
        expect(splitLocation("Lahore")).toEqual({ city: "Lahore", state: null, country: null });
        expect(splitLocation("Lahore, Pakistan")).toEqual({ city: "Lahore", state: null, country: "Pakistan" });
        expect(splitLocation("Lahore, Punjab, Pakistan")).toEqual({ city: "Lahore", state: "Punjab", country: "Pakistan" });
        expect(splitLocation(null)).toEqual({ city: null, state: null, country: null });
    });
});
