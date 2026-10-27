import bidiFactory from "bidi-js";
import { fileURLToPath } from "node:url";
const bidi = bidiFactory();
const graphemes = new Intl.Segmenter("ur", { granularity: "grapheme" });
const words = new Intl.Segmenter("ur", { granularity: "word" });
const arabic = /\p{Script_Extensions=Arabic}/u;
const formats = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu;
const reverse = (text) =>
  [...graphemes.segment(text)]
    .map((p) => p.segment)
    .reverse()
    .join("");
export const REPORT_FONTS = Object.freeze({
  latin: fileURLToPath(
    new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
  ),
  arabic: fileURLToPath(
    new URL("../../assets/fonts/NotoSansArabic-Regular.ttf", import.meta.url),
  ),
});

// Reorder runs, not Arabic characters: Fontkit still receives each Arabic word
// in logical order so it can shape joins and marks. Numeric and neutral runs
// compensate for the font's inherent direction; UAX #9 determines their order.
export function visualTextRuns(
  text,
  embedding = bidi.getEmbeddingLevels(text),
  start = 0,
  end = text.length - 1,
) {
  if (end < start) return [];
  const runs = [],
    owner = new Map();
  for (const part of graphemes.segment(text.slice(start, end + 1))) {
    const index = start + part.index,
      level = embedding.levels[index],
      font = arabic.test(part.segment) ? "arabic" : "latin";
    let run = runs.at(-1);
    if (!run || run.level !== level || run.font !== font) {
      run = { font, level, text: "", indices: [] };
      runs.push(run);
    }
    run.text += part.segment;
    for (let n = index; n < index + part.segment.length; n++) {
      owner.set(n, run);
      run.indices.push(n);
    }
  }
  const visual = [],
    seen = new Set();
  const order = Array.from(
    { length: end - start + 1 },
    (_, index) => start + index,
  );
  for (const [first, last] of bidi.getReorderSegments(
    text,
    embedding,
    start,
    end,
  )) {
    for (
      let left = first - start, right = last - start;
      left < right;
      left++, right--
    ) {
      [order[left], order[right]] = [order[right], order[left]];
    }
  }
  for (const index of order) {
    const run = owner.get(index);
    if (!run || seen.has(run)) continue;
    seen.add(run);
    let value = run.text;
    // Fontkit mirrors Arabic script punctuation; Latin neutral runs need UAX mirroring here.
    if (run.font === "latin" && run.level % 2)
      value = [...value].map((c) => bidi.getMirroredCharacter(c) || c).join("");
    const fontRtl = run.font === "arabic",
      targetRtl = run.level % 2 === 1;
    if (fontRtl !== targetRtl) value = reverse(value);
    visual.push({ text: value, font: run.font, level: run.level });
  }
  return visual;
}

export function createReportText(doc) {
  doc.registerFont(
    "ReportLatin",
    process.env.HR_REPORT_FONT_PATH || REPORT_FONTS.latin,
  );
  doc.registerFont("ReportArabic", REPORT_FONTS.arabic);
  const fontName = (font) =>
    font === "arabic" ? "ReportArabic" : "ReportLatin";
  const measure = (runs) =>
    runs.reduce(
      (sum, run) =>
        sum +
        doc.font(fontName(run.font)).widthOfString(run.text, { features: [] }),
      0,
    );
  return (value, size = 11, { keepWithNext = false } = {}) => {
    if (
      keepWithNext &&
      doc.y + size * 5 > doc.page.height - doc.page.margins.bottom
    )
      doc.addPage();
    // Direction controls are formatting, not evidence. Keep the original frozen
    // content in storage; normalize only the visible report to avoid direction overrides.
    const source = String(value ?? "")
      .replace(formats, "")
      .replace(/\t/g, "    ")
      .replace(/\r\n?/g, "\n");
    doc.fontSize(size).fillColor("#1d343c");
    const width =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;
    for (const paragraph of source.split("\n")) {
      if (!paragraph) {
        doc.y += size;
        continue;
      }
      const embedding = bidi.getEmbeddingLevels(paragraph),
        ranges = [];
      let start = 0,
        end = 0;
      const push = (limit) => {
        if (limit > start) ranges.push([start, limit - 1]);
        start = limit;
        end = limit;
      };
      for (const word of words.segment(paragraph)) {
        const next = word.index + word.segment.length;
        if (
          measure(visualTextRuns(paragraph, embedding, start, next - 1)) <=
          width
        ) {
          end = next;
          continue;
        }
        if (end > start) push(end);
        // An unbroken identifier or pasted paragraph must not leave the page.
        for (const cluster of graphemes.segment(word.segment)) {
          const clusterEnd =
            word.index + cluster.index + cluster.segment.length;
          if (
            end > start &&
            measure(
              visualTextRuns(paragraph, embedding, start, clusterEnd - 1),
            ) > width
          )
            push(end);
          end = clusterEnd;
        }
      }
      push(end);
      for (const [a, b] of ranges) {
        const logical = paragraph.slice(a, b + 1),
          runs = visualTextRuns(paragraph, embedding, a, b),
          hasArabic = runs.some((r) => r.font === "arabic");
        const height = size * (hasArabic ? 2.3 : 1.45),
          baseline = size * (hasArabic ? 1.45 : 1.15);
        if (doc.y + height > doc.page.height - doc.page.margins.bottom)
          doc.addPage();
        const y = doc.y,
          total = measure(runs);
        let x =
          doc.page.margins.left +
          (embedding.paragraphs[0].level % 2 ? Math.max(0, width - total) : 0);
        const tag = size >= 16 ? "H1" : size >= 13 ? "H2" : "P";
        const structure = doc.markStructureContent(tag);
        doc.markContent("Span", {
          actual: logical,
          lang: hasArabic ? "ur" : "en",
        });
        for (const run of runs) {
          doc.font(fontName(run.font)).fillColor("#1d343c");
          const advance = doc.widthOfString(run.text, { features: [] });
          doc.text(run.text, x, y + baseline, {
            lineBreak: false,
            baseline: "alphabetic",
            features: [],
          });
          x += advance;
        }
        doc.endMarkedContent();
        doc.endMarkedContent();
        doc.addStructure(
          doc.struct(tag, { lang: hasArabic ? "ur" : "en" }, [structure]),
        );
        doc.x = doc.page.margins.left;
        doc.y = y + height;
      }
    }
    doc.y += size * 0.3;
  };
}
