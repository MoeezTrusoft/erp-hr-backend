// src/lib/export.util.js — shared serializers for HR export tools.
// CSV is dependency-free; PDF uses pdfkit (pure JS, works under
// `npm ci --ignore-scripts`). Callers pass a column spec + rows and get a
// Buffer back; the MCP tool base64-encodes it for the JSON-RPC response.
import PDFDocument from "pdfkit";

const csvCell = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const cellValue = (col, row) => (typeof col.value === "function" ? col.value(row) : row[col.key]);

// columns: [{ key, header?, value?(row) }]; rows: object[]
export function toCSV(columns, rows) {
  const head = columns.map((c) => csvCell(c.header ?? c.key)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(cellValue(c, r))).join(","));
  return [head, ...body].join("\r\n");
}

// Simple paginated table PDF. Returns Promise<Buffer>.
export function toPDFTable({ title, subtitle, columns, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).font("Helvetica-Bold").text(title || "Export");
    if (subtitle) doc.moveDown(0.2).fontSize(9).font("Helvetica").fillColor("#666").text(subtitle);
    doc.fillColor("#000").moveDown(0.5);

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = pageWidth / columns.length;
    const rowHeight = 18;
    let y = doc.y;

    const drawRow = (cells, header = false) => {
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.fontSize(8).font(header ? "Helvetica-Bold" : "Helvetica");
      cells.forEach((text, i) => {
        doc.text(String(text ?? ""), left + i * colWidth + 2, y + 4, {
          width: colWidth - 4, height: rowHeight, ellipsis: true, lineBreak: false,
        });
      });
      doc.moveTo(left, y + rowHeight).lineTo(left + pageWidth, y + rowHeight).strokeColor("#dddddd").stroke();
      y += rowHeight;
    };

    drawRow(columns.map((c) => c.header ?? c.key), true);
    rows.forEach((r) => drawRow(columns.map((c) => cellValue(c, r))));
    doc.end();
  });
}

// Uniform entry point. format: "csv" | "pdf". Returns { mimeType, ext, buffer }.
export async function exportRows(format, { title, subtitle, columns, rows }) {
  if (format === "csv") {
    return { mimeType: "text/csv", ext: "csv", buffer: Buffer.from(toCSV(columns, rows), "utf8") };
  }
  if (format === "pdf") {
    const buffer = await toPDFTable({ title, subtitle, columns, rows });
    return { mimeType: "application/pdf", ext: "pdf", buffer };
  }
  throw new Error(`Unsupported export format: ${format}`);
}
