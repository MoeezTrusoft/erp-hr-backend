// scripts/generate-employee-import-template.js
//
// Emits the employee bulk-import template as an .xlsx, generated FROM
// IMPORT_COLUMNS rather than hand-maintained — so the template can never drift
// from what the importer actually accepts.
//
//   node scripts/generate-employee-import-template.js [outputPath]
//
// Sheets:
//   Employees    the header row to fill in, with an example row
//   Field guide  every column: required?, allowed values, what it is for
//
// HR-EMP-IMPORT-TEMPLATE-01.
import { writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { IMPORT_COLUMNS, headerLabel } from "../src/lib/employeeImportTaxonomy.js";

const out = process.argv[2] || "employee-import-template.xlsx";

const EXAMPLE = {
  first_name: "Asad", last_name: "Ullah", employee_code: "EMP301",
  biometric_id: "3101", gender: "Male", date_of_birth: "1995-04-12",
  marital_status: "Single", nationality: "Pakistani", national_id_type: "CNIC",
  national_id_number: "42101-1234567-8", personal_email: "asad@example.com",
  work_email: "asad.ullah@trusoft.pk", mobile_phone: "03001234567",
  city: "Karachi", country: "Pakistan", job_title: "Software Engineer",
  employment_type: "Full-time", employment_status: "Active",
};

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TruSoft ERP";

  const ws = wb.addWorksheet("Employees");
  ws.columns = IMPORT_COLUMNS.map((c) => ({
    header: headerLabel(c),
    key: c.key,
    width: Math.min(Math.max(headerLabel(c).length + 4, 14), 34),
  }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;
  IMPORT_COLUMNS.forEach((c, i) => {
    // Required columns stand out, so a filler cannot miss them.
    header.getCell(i + 1).fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: c.required ? "FFC00000" : "FF4472C4" },
    };
  });
  ws.addRow(IMPORT_COLUMNS.reduce((a, c) => ({ ...a, [c.key]: EXAMPLE[c.key] ?? "" }), {}));
  ws.getRow(2).font = { italic: true, color: { argb: "FF808080" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // Dropdowns for every enumerated column, so values cannot be mistyped.
  IMPORT_COLUMNS.forEach((c, i) => {
    if (!c.enum?.length) return;
    const col = ws.getColumn(i + 1).letter;
    for (let r = 2; r <= 500; r++) {
      ws.getCell(`${col}${r}`).dataValidation = {
        type: "list", allowBlank: !c.required,
        formulae: [`"${c.enum.join(",")}"`],
        showErrorMessage: true,
        error: `Pick one of: ${c.enum.join(", ")}`,
      };
    }
  });

  const guide = wb.addWorksheet("Field guide");
  guide.columns = [
    { header: "Column", key: "label", width: 26 },
    { header: "Required", key: "req", width: 10 },
    { header: "Allowed values", key: "vals", width: 40 },
    { header: "What it is for", key: "note", width: 86 },
  ];
  guide.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  guide.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
  for (const c of IMPORT_COLUMNS) {
    guide.addRow({
      label: headerLabel(c),
      req: c.required ? "YES" : "",
      vals: c.enum ? c.enum.join(", ")
        : c.date ? "a date (YYYY-MM-DD preferred)"
        : c.lookup ? "pick from existing " + c.lookup + "s"
        : c.email ? "email address" : c.phone ? "phone number" : "",
      note: c.note || "",
    });
  }
  guide.views = [{ state: "frozen", ySplit: 1 }];
  guide.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: "top", wrapText: true }; });

  const buf = await wb.xlsx.writeBuffer();
  writeFileSync(out, Buffer.from(buf));
  console.log(`wrote ${out} — ${IMPORT_COLUMNS.length} columns, ${IMPORT_COLUMNS.filter(c => c.required).length} required`);
}

main().catch((e) => { console.error(e); process.exit(1); });
