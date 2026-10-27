import PDFDocument from "pdfkit";
import { OfferLetterTemplate } from "@trusoft/contracts/recruitment-policy";
export const offerLetterError = (message, status = 409) =>
  Object.assign(new Error(message), { status, code: "HR-5511" });

export function renderOfferLetter({
  offer,
  candidate,
  requisition,
  employerName,
  version,
  template,
}) {
  if (!Number.isFinite(Number(offer.salary)) || Number(offer.salary) <= 0)
    throw offerLetterError("A valid base salary is required", 422);
  const companyTemplate = template ? OfferLetterTemplate.parse(template) : null;
  if (companyTemplate) employerName = companyTemplate.employerName;
  const fields = {
    employerName,
    candidateName: [candidate.firstName, candidate.lastName]
      .filter(Boolean)
      .join(" "),
    positionTitle:
      requisition.title ||
      requisition.position?.title ||
      "Position " + requisition.id,
    baseSalary: Number(offer.salary).toLocaleString("en-US", {
      maximumFractionDigits: 2,
    }),
    currency: offer.currency,
    startDate: offer.startDate
      ? new Date(offer.startDate).toISOString().slice(0, 10)
      : "To be agreed",
    expiryDate: offer.expiryDate
      ? new Date(offer.expiryDate).toISOString().slice(0, 10) + " (UTC)"
      : "Not specified",
  };
  const merge = (value) =>
    value.replace(/{{\s*([A-Za-z]+)\s*}}/g, (_match, name) =>
      String(fields[name]),
    );
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 52,
      bufferPages: true,
      info: { Title: "Employment offer", Author: employerName },
    });
    const chunks = [];
    doc.on("data", (part) => chunks.push(part));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    if (process.env.HR_REPORT_FONT_PATH)
      doc.font(process.env.HR_REPORT_FONT_PATH);
    const line = (value, size = 11) => {
      doc.fontSize(size).fillColor("#19333c").text(String(value));
      doc.moveDown(0.65);
    };
    line(employerName, 18);
    if (companyTemplate?.employerAddress)
      line(companyTemplate.employerAddress, 10);
    line("Employment offer", 24);
    line("Offer " + offer.id + " · Letter version " + version, 10);
    line(
      "Dear " +
        [candidate.firstName, candidate.lastName].filter(Boolean).join(" ") +
        ",",
    );
    line(
      companyTemplate
        ? merge(companyTemplate.openingText)
        : "We are pleased to offer you the following position on the terms set out below.",
    );
    line(
      "Position: " +
        (requisition.title ||
          requisition.position?.title ||
          "Position " + requisition.id),
    );
    line("Employee category: " + (offer.employeeCategory || "To be confirmed"));
    line(
      "Base salary: " +
        offer.currency +
        " " +
        Number(offer.salary).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        }),
    );
    if (offer.employmentType) line("Employment type: " + offer.employmentType);
    if (offer.startDate)
      line(
        "Start date: " + new Date(offer.startDate).toISOString().slice(0, 10),
      );
    if (offer.expiryDate)
      line(
        "Offer expires: " +
          new Date(offer.expiryDate).toISOString().slice(0, 10) +
          " (UTC)",
      );
    const terms = offer.terms ?? {};
    const comp = offer.compensation ?? {};
    for (const [label, value] of [
      ["Salary frequency", comp.salaryFrequency],
      ["Bonus", comp.bonus],
      ["Allowances", comp.allowances],
      ["Work location", terms.workLocation],
      ["Department", terms.department],
    ])
      if (value != null && value !== "") line(label + ": " + value);
    if (Array.isArray(comp.benefits))
      for (const benefit of comp.benefits) line("Benefit: " + benefit);
    if (terms.probationMonths != null)
      line("Probation: " + terms.probationMonths + " months");
    if (terms.noticePeriodDays != null)
      line("Notice period: " + terms.noticePeriodDays + " days");
    for (const value of new Set([
      terms.additionalTerms,
      terms.specialClauses,
    ])) {
      if (typeof value === "string" && value.trim()) line(value);
      else if (Array.isArray(value))
        for (const entry of value) if (typeof entry === "string") line(entry);
    }
    // Recruiter notes are deliberately excluded from candidate-facing letters.
    line(
      companyTemplate
        ? merge(companyTemplate.closingText)
        : "By signing this letter, you accept this offer and its terms. Open the LibreSign invitation sent to your verified email address to sign.",
    );
    line("For " + employerName);
    if (companyTemplate?.signatoryName) line(companyTemplate.signatoryName);
    if (companyTemplate?.signatoryTitle) line(companyTemplate.signatoryTitle);
    const range = doc.bufferedPageRange();
    for (let page = 0; page < range.count; page++) {
      doc.switchToPage(page);
      doc
        .fontSize(8)
        .fillColor("#52666b")
        .text(
          "Offer " +
            offer.id +
            " | Version " +
            version +
            " | Page " +
            (page + 1) +
            " of " +
            range.count,
          52,
          790,
          { lineBreak: false },
        );
    }
    doc.end();
  });
}
