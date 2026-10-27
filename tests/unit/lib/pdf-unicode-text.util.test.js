// Recruitment Phase 7 (B18b) — the pdfkit text helper: which text the
// standard fonts can draw, the direction runs of a left-to-right line, the
// pieces in visual order, and the calls made on the document.
import { describe, it, expect, jest } from "@jest/globals";

import {
    UNICODE_FONT_NAME,
    bidiRuns,
    isWinAnsiText,
    textPieces,
    writeText,
} from "../../../src/lib/pdf-unicode-text.util.js";

describe("isWinAnsiText", () => {
    it("is true for ASCII, Latin-1 accents and the WinAnsi extras", () => {
        expect(isWinAnsiText("Zoe Khan")).toBe(true);
        expect(isWinAnsiText("Zoé Müller, Ångström")).toBe(true);
        expect(isWinAnsiText("“quoted” – € …")).toBe(true);
        expect(isWinAnsiText("")).toBe(true);
    });

    it("is false for Urdu, Arabic, Chinese and Latin Extended letters", () => {
        for (const name of ["محمد", "عائشہ", "王小明", "Łukasz", "Şahin", "Nguyễn"]) expect(isWinAnsiText(name)).toBe(false);
    });
});

describe("bidiRuns / textPieces", () => {
    it("keeps a right-to-left name (with its inner spaces) as one run inside a left-to-right line", () => {
        expect(bidiRuns("Dear محمد علی,")).toEqual([
            { text: "Dear ", rtl: false },
            { text: "محمد علی", rtl: true },
            { text: ",", rtl: false },
        ]);
    });

    it("reverses the words of a right-to-left run and marks every non-WinAnsi piece", () => {
        expect(textPieces("Dear محمد علی ٹیپو, welcome")).toEqual([
            { text: "Dear ", unicode: false },
            { text: "ٹیپو", unicode: true },
            { text: " ", unicode: true },
            { text: "علی", unicode: true },
            { text: " ", unicode: true },
            { text: "محمد", unicode: true },
            { text: ", welcome", unicode: false },
        ]);
        expect(textPieces("Łukasz Wójcik")).toEqual([{ text: "Łukasz Wójcik", unicode: true }]);
    });
});

const fakeDoc = () => {
    const calls = [];
    const doc = {
        x: 56,
        y: 100,
        font: jest.fn((name) => { calls.push(["font", name]); return doc; }),
        text: jest.fn((...args) => { calls.push(["text", ...args]); return doc; }),
        registerFont: jest.fn(),
        widthOfString: jest.fn((text) => text.length * 5),
    };
    return { doc, calls };
};

describe("writeText", () => {
    it("WinAnsi text is the single call it always was", () => {
        const { doc, calls } = fakeDoc();
        expect(writeText(doc, "Zoé Khan", { font: "Helvetica-Bold", x: 10, y: 20, options: { width: 100 } })).toEqual({ unicode: false });
        expect(calls).toEqual([["font", "Helvetica-Bold"], ["text", "Zoé Khan", 10, 20, { width: 100 }]]);
        expect(doc.registerFont).not.toHaveBeenCalled();
    });

    it("non-Latin text registers the Unicode font once and writes continued pieces line by line", () => {
        const { doc, calls } = fakeDoc();
        writeText(doc, "Dear علی\nThanks", { font: "Helvetica", options: { width: 400 } });
        writeText(doc, "محمد", { font: "Helvetica", options: { width: 400 } });
        expect(doc.registerFont).toHaveBeenCalledTimes(1);
        expect(doc.registerFont.mock.calls[0][0]).toBe(UNICODE_FONT_NAME);
        const texts = calls.filter((c) => c[0] === "text").map((c) => [c[1], c.at(-1).continued]);
        expect(texts).toEqual([["Dear ", true], ["علی", false], ["Thanks", false], ["محمد", false]]);
        expect(calls.filter((c) => c[0] === "font").map((c) => c[1])).toEqual(["Helvetica", UNICODE_FONT_NAME, "Helvetica", UNICODE_FONT_NAME]);
    });

    it("a centred non-Latin line is measured and drawn left-aligned from the centring offset", () => {
        const { doc, calls } = fakeDoc();
        writeText(doc, "ٹرو سافٹ", { font: "Helvetica-Bold", options: { align: "center", width: 200 } });
        const texts = calls.filter((c) => c[0] === "text");
        // three pieces of 4, 1 and 3 characters at 5 pt each: 40 wide, centred in 200
        expect(texts[0].slice(1, 4)).toEqual(["سافٹ", 56 + 80, 100]);
        expect(texts.every((c) => c.at(-1).align === "left")).toBe(true);
        expect(doc.x).toBe(56);
    });
});
