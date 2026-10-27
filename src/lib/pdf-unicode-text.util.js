// src/lib/pdf-unicode-text.util.js
//
// Recruitment Phase 7 (B18b) — text in a pdfkit document that may not be
// Latin. pdfkit's standard fonts (Helvetica) only encode WinAnsi (Latin-1 plus
// a few typographic signs); anything else, an Urdu, Arabic or Polish name for
// instance, came out as garbage. This module writes such text with the
// bundled Unicode font (src/assets/fonts/OrgSans.ttf, DejaVu Sans: Latin,
// Latin Extended, Greek, Cyrillic and most of Arabic, embedded as a subset)
// and leaves WinAnsi text EXACTLY as before, so a Latin letter renders the
// same bytes it always did.
//
// Right-to-left runs (Hebrew, Arabic, Urdu) inside a left-to-right line are
// laid out word by word in reverse order: fontkit shapes and mirrors each word
// itself, and pdfkit places words in the order it is given them, so reversing
// the words of the run gives the right visual order. That covers names and
// short phrases in an English letter; a whole right-to-left paragraph that
// wraps over several lines is not reordered line by line.
//
// Characters the bundled font lacks (Chinese, Japanese, Korean, and a few
// Urdu letters such as U+06D2 and U+06C1) still render as the font's empty box;
// see the Phase 7 stream B integration note for the font to vendor.
//
// Pure apart from reading the font file once; pdfkit is passed in.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import logger from "./logger.js";

export const UNICODE_FONT_PATH = fileURLToPath(new URL("../assets/fonts/OrgSans.ttf", import.meta.url));
export const UNICODE_FONT_NAME = "HrUnicodeSans";

// pdfkit's WIN_ANSI_MAP: the code points above Latin-1 it can still encode.
const WIN_ANSI_EXTRA = new Set([
    402, 710, 732, 338, 339, 352, 353, 376, 381, 382,
    8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8224, 8225, 8226, 8230, 8240, 8249, 8250, 8364, 8482,
]);

const isWinAnsiCodePoint = (cp) => cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);

/** Can the standard PDF fonts draw every character of this text? */
export function isWinAnsiText(text) {
    for (const ch of String(text ?? "")) {
        if (!isWinAnsiCodePoint(ch.codePointAt(0))) return false;
    }
    return true;
}

// Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Arabic Extended,
// and the Hebrew / Arabic presentation forms.
const isRtlCodePoint = (cp) =>
    (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);

// Spaces, punctuation, symbols and (European) digits take the direction of
// their surroundings.
const NEUTRAL_RE = /[\s\p{P}\p{S}\p{N}]/u;

function classify(ch) {
    const cp = ch.codePointAt(0);
    if (isRtlCodePoint(cp)) return "R";
    return NEUTRAL_RE.test(ch) ? "N" : "L";
}

/**
 * Split text into direction runs for a left-to-right line: a neutral run
 * between two right-to-left runs joins them, any other neutral is
 * left-to-right.
 * @returns {Array<{ text: string, rtl: boolean }>}
 */
export function bidiRuns(text) {
    const chars = Array.from(String(text ?? ""));
    const classes = chars.map(classify);
    const resolved = classes.map((cls, i) => {
        if (cls !== "N") return cls;
        let before = null;
        for (let j = i - 1; j >= 0 && before === null; j -= 1) if (classes[j] !== "N") before = classes[j];
        let after = null;
        for (let j = i + 1; j < classes.length && after === null; j += 1) if (classes[j] !== "N") after = classes[j];
        return before === "R" && after === "R" ? "R" : "L";
    });
    const runs = [];
    chars.forEach((ch, i) => {
        const rtl = resolved[i] === "R";
        const last = runs.at(-1);
        if (last && last.rtl === rtl) last.text += ch;
        else runs.push({ text: ch, rtl });
    });
    return runs;
}

/**
 * The pieces to draw, in visual order, each with the font it needs: WinAnsi
 * pieces keep `font`, the rest use the Unicode font; a right-to-left run is
 * split into words and whitespace in reverse order.
 * @returns {Array<{ text: string, unicode: boolean }>}
 */
export function textPieces(text) {
    const pieces = [];
    for (const run of bidiRuns(text)) {
        if (run.rtl) {
            for (const token of run.text.split(/(\s+)/).filter(Boolean).reverse()) pieces.push({ text: token, unicode: true });
        } else {
            pieces.push({ text: run.text, unicode: !isWinAnsiText(run.text) });
        }
    }
    return pieces;
}

let fontBuffer;
function unicodeFont() {
    if (fontBuffer === undefined) {
        try {
            fontBuffer = readFileSync(UNICODE_FONT_PATH);
        } catch (err) {
            // A deploy without the asset still renders: non-Latin text falls
            // back to the standard font (wrong glyphs, never a crash).
            logger.warn({ err: err?.message }, "pdf text: the bundled Unicode font could not be read");
            fontBuffer = null;
        }
    }
    return fontBuffer;
}

const registered = new WeakSet();

// pdfkit positions each continued piece of a centred or right-aligned line on
// its own, so such a line is measured here and drawn left-aligned from the
// offset that centres (or right-aligns) the whole. A line wider than the box
// falls back to the left-aligned flow (it wraps).
function writeAlignedLine(doc, pieces, { font, at, options }) {
    const fontOf = (piece) => (piece.unicode ? UNICODE_FONT_NAME : font);
    let total = 0;
    for (const piece of pieces) total += doc.font(fontOf(piece)).widthOfString(piece.text, options);
    if (total > options.width) return false;
    const baseX = at.length ? at[0] : doc.x;
    const offset = options.align === "right" ? options.width - total : (options.width - total) / 2;
    pieces.forEach((piece, index) => {
        const position = index === 0 ? [baseX + offset, at.length ? at[1] : doc.y] : [];
        doc.font(fontOf(piece)).text(piece.text, ...position, {
            ...options, align: "left", width: total + 1, continued: index < pieces.length - 1,
        });
    });
    doc.x = baseX;
    return true;
}

/**
 * Write text into a pdfkit document with `font` (a standard font name such as
 * "Helvetica-Bold"), switching to the bundled Unicode font for the parts the
 * standard font cannot draw. WinAnsi text takes exactly the single
 * doc.font(font).text(...) call it took before. x / y position the first
 * line like doc.text(text, x, y, options).
 *
 * @param {object} doc  a PDFDocument
 * @param {string} text
 * @param {{ font: string, x?: number, y?: number, options?: object }} how
 * @returns {{ unicode: boolean }} whether the Unicode font was used
 */
export function writeText(doc, text, { font, x, y, options = {} } = {}) {
    const value = String(text ?? "");
    const at = x === undefined && y === undefined ? [] : [x, y];
    const buffer = isWinAnsiText(value) ? null : unicodeFont();
    if (!buffer) {
        doc.font(font).text(value, ...at, options);
        return { unicode: false };
    }
    if (!registered.has(doc)) {
        doc.registerFont(UNICODE_FONT_NAME, buffer);
        registered.add(doc);
    }
    // Line by line: a newline inside a run of continued pieces is lost.
    const aligned = (options.align === "center" || options.align === "right") && Number(options.width) > 0;
    value.split(/\r?\n/).forEach((line, lineIndex) => {
        const first = lineIndex === 0 ? at : [];
        const pieces = line ? textPieces(line) : [{ text: " ", unicode: false }];
        if (aligned && writeAlignedLine(doc, pieces, { font, at: first, options })) return;
        pieces.forEach((piece, index) => {
            doc.font(piece.unicode ? UNICODE_FONT_NAME : font);
            doc.text(piece.text, ...(index === 0 ? first : []), { ...options, continued: index < pieces.length - 1 });
        });
    });
    return { unicode: true };
}
