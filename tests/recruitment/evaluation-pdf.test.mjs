import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import {
  createReportText,
  visualTextRuns,
  REPORT_FONTS,
} from "../../src/services/candidate-assessment/pdfText.js";
const require = createRequire(import.meta.url),
  fontkit = createRequire(require.resolve("pdfkit"))("fontkit");
const fonts = Object.fromEntries(
  Object.entries(REPORT_FONTS).map(([key, path]) => [
    key,
    fontkit.openSync(path),
  ]),
);
function contentStreams(buffer) {
  const raw = buffer.toString("latin1"),
    streams = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      streams.push(
        inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"),
      );
    } catch {
      /* Non-flate streams are irrelevant. */
    }
  }
  return streams.join("\n");
}
async function render(lines) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    tagged: true,
    pdfVersion: "1.5",
    bufferPages: true,
  });
  const chunks = [],
    painted = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const original = doc.text;
  doc.text = function (text, x, y, options) {
    painted.push({
      text,
      x,
      y,
      width: doc.widthOfString(text, { features: [] }),
      pageWidth: doc.page.width,
      pageHeight: doc.page.height,
    });
    return original.call(this, text, x, y, options);
  };
  const line = createReportText(doc);
  for (const text of lines) line(text);
  const pages = doc.bufferedPageRange().count;
  doc.end();
  return { buffer: await done, painted, pages };
}
test("Arabic words retain logical order for shaping while Latin identifiers and parentheses retain reading order", () => {
  const runs = visualTextRuns("عائشہ علی (Ayesha Ali) 123");
  assert.equal(runs[0].text, "123");
  assert.equal(runs.map((r) => r.text).join(""), "123 (Ayesha Ali) علی عائشہ");
  assert.equal(runs.at(-1).text, "عائشہ");
  assert.ok(runs.some((r) => r.text === "Ayesha Ali"));
});
test("Urdu digits keep numeric order after the font's RTL glyph layout", () => {
  const run = visualTextRuns("اسکور ۱۲۳")[0];
  assert.equal(run.font, "arabic");
  const shaped = fonts.arabic.layout(run.text, []);
  assert.equal(
    shaped.glyphs.map((g) => String.fromCodePoint(...g.codePoints)).join(""),
    "۱۲۳",
  );
});
test("bundled licensed fonts cover Urdu evidence, vowel marks, numbers and English labels without missing glyphs", () => {
  for (const input of [
    "امیدوار نے مسئلے کا حل واضح طور پر بیان کیا۔",
    "مدیرِ اشاعت - Editorial Manager (HR-123)",
    "اسکور ۷۸.۵٪",
  ])
    for (const run of visualTextRuns(input)) {
      const shaped = fonts[run.font].layout(run.text, []);
      assert.ok(
        shaped.glyphs.every((g) => g.id !== 0),
        run.text,
      );
    }
  assert.match(
    readFileSync(
      new URL("../../src/assets/fonts/NotoSansArabic-OFL.txt", import.meta.url),
      "utf8",
    ),
    /SIL OPEN FONT LICENSE/,
  );
});
test("tagged PDF preserves original logical Unicode text separately from visual glyph order", async () => {
  const source = "عائشہ علی (Ayesha Ali) 123";
  const { buffer } = await render([source]);
  assert.match(buffer.toString("latin1"), /\/StructTreeRoot/);
  const content = contentStreams(buffer);
  const logical = [
    ...content.matchAll(/\/ActualText \(((?:\\[\s\S]|[^\\)])*)\)/g),
  ].map((match) => {
    const decoded = match[1].replace(/\\([0-7]{1,3}|[\s\S])/g, (_, escaped) =>
      /^[0-7]+$/.test(escaped)
        ? String.fromCharCode(parseInt(escaped, 8))
        : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[escaped] ?? escaped),
    );
    const bytes = Buffer.from(decoded, "latin1");
    return bytes[0] === 0xfe && bytes[1] === 0xff
      ? bytes.subarray(2).swap16().toString("utf16le")
      : bytes.toString("utf8");
  });
  assert.ok(logical.includes(source));
});
test("mixed paragraphs and unbroken identifiers wrap within margins across pages", async () => {
  const { painted, pages } = await render([
    "امیدوار نے مسئلے کا حل بیان کیا۔ Result HR-123. ".repeat(120),
    "REFERENCE".repeat(300),
  ]);
  assert.ok(pages > 1);
  assert.ok(painted.length > 30);
  for (const row of painted) {
    assert.ok(row.x >= 47.9);
    assert.ok(row.x + row.width <= row.pageWidth - 47.9, row.text);
    assert.ok(row.y > 0 && row.y < row.pageHeight - 47.9);
  }
});
