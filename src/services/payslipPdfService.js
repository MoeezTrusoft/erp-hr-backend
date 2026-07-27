// src/services/payslipPdfService.js — Generate payslip PDFs using PDFKit
import PDFDocument from "pdfkit";

/**
 * Generate a professional payslip PDF for a single payslip.
 * @param {Object} payslip - The payslip object with earnings, deductions, employee info
 * @param {Object} options - { companyName, companyAddress, companyLogo }
 * @returns {Promise<Buffer>} PDF buffer
 */
export const generatePayslipPdf = async (payslip, options = {}) => {
    const {
        companyName = "TruSoft Solutions",
        companyAddress = "",
        currency = "PKR",
    } = options;

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margin: 40,
            bufferPages: true,
            info: {
                Title: `Payslip - ${payslip.employeeName || "Employee"}`,
                Author: companyName,
            },
        });

        const chunks = [];
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        // ── HEADER ──
        doc.fontSize(20).font("Helvetica-Bold").text(companyName, { align: "center" });
        if (companyAddress) {
            doc.fontSize(9).font("Helvetica").text(companyAddress, { align: "center" });
        }
        doc.moveDown(0.3);
        doc.fontSize(16).font("Helvetica-Bold").text("PAYSLIP", { align: "center" });
        doc.moveDown(0.5);

        // ── EMPLOYEE INFO ──
        const infoTop = doc.y;
        doc.fontSize(10).font("Helvetica-Bold").text("Employee:", 40, infoTop);
        doc.font("Helvetica").text(payslip.employeeName || "N/A", 130, infoTop);
        doc.font("Helvetica-Bold").text("Period:", 320, infoTop);
        doc.font("Helvetica").text(`${payslip.periodStart || ""} — ${payslip.periodEnd || ""}`, 380, infoTop);

        doc.font("Helvetica-Bold").text("Employee ID:", 40, infoTop + 16);
        doc.font("Helvetica").text(String(payslip.employeeId || ""), 130, infoTop + 16);
        doc.font("Helvetica-Bold").text("Pay Date:", 320, infoTop + 16);
        doc.font("Helvetica").text(payslip.payDate || payslip.periodEnd || "", 380, infoTop + 16);

        if (payslip.department || payslip.jobTitle) {
            doc.font("Helvetica-Bold").text("Department:", 40, infoTop + 32);
            doc.font("Helvetica").text(payslip.department || "", 130, infoTop + 32);
            doc.font("Helvetica-Bold").text("Designation:", 320, infoTop + 32);
            doc.font("Helvetica").text(payslip.jobTitle || "", 380, infoTop + 32);
        }

        doc.y = infoTop + 50;
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke("#999999");
        doc.moveDown(0.5);

        // ── EARNINGS TABLE ──
        const tableLeft = 40;
        const descWidth = 300;
        const amtWidth = 100;
        const colAmt = tableLeft + descWidth;

        doc.fontSize(11).font("Helvetica-Bold").text("Earnings", tableLeft);
        doc.moveDown(0.3);

        // Table header
        const headerY = doc.y;
        doc.fontSize(9).font("Helvetica-Bold")
            .text("Description", tableLeft, headerY, { width: descWidth })
            .text("Amount", colAmt, headerY, { width: amtWidth, align: "right" });
        doc.moveDown(0.2);
        doc.moveTo(tableLeft, doc.y).lineTo(tableLeft + descWidth + amtWidth, doc.y).stroke("#CCCCCC");
        doc.moveDown(0.3);

        let totalEarnings = 0;
        const earnings = payslip.earnings || [];
        for (const e of earnings) {
            const y = doc.y;
            const amount = typeof e.amount === "number" ? e.amount : parseFloat(e.amount) || 0;
            totalEarnings += amount;
            doc.fontSize(9).font("Helvetica")
                .text(e.description || "—", tableLeft, y, { width: descWidth })
                .text(formatCurrency(amount, currency), colAmt, y, { width: amtWidth, align: "right" });
            doc.moveDown(0.2);
        }

        // Total earnings
        doc.moveTo(tableLeft, doc.y).lineTo(tableLeft + descWidth + amtWidth, doc.y).stroke("#CCCCCC");
        doc.moveDown(0.3);
        doc.fontSize(9).font("Helvetica-Bold")
            .text("Total Earnings", tableLeft, doc.y, { width: descWidth })
            .text(formatCurrency(totalEarnings, currency), colAmt, doc.y, { width: amtWidth, align: "right" });
        doc.moveDown(0.8);

        // ── DEDUCTIONS TABLE ──
        doc.fontSize(11).font("Helvetica-Bold").text("Deductions", tableLeft);
        doc.moveDown(0.3);

        const dedHeaderY = doc.y;
        doc.fontSize(9).font("Helvetica-Bold")
            .text("Description", tableLeft, dedHeaderY, { width: descWidth })
            .text("Amount", colAmt, dedHeaderY, { width: amtWidth, align: "right" });
        doc.moveDown(0.2);
        doc.moveTo(tableLeft, doc.y).lineTo(tableLeft + descWidth + amtWidth, doc.y).stroke("#CCCCCC");
        doc.moveDown(0.3);

        let totalDeductions = 0;
        const deductions = payslip.deductions || [];
        for (const d of deductions) {
            const y = doc.y;
            const amount = typeof d.amount === "number" ? d.amount : parseFloat(d.amount) || 0;
            totalDeductions += amount;
            doc.fontSize(9).font("Helvetica")
                .text(d.description || "—", tableLeft, y, { width: descWidth })
                .text(formatCurrency(amount, currency), colAmt, y, { width: amtWidth, align: "right" });
            doc.moveDown(0.2);
        }

        doc.moveTo(tableLeft, doc.y).lineTo(tableLeft + descWidth + amtWidth, doc.y).stroke("#CCCCCC");
        doc.moveDown(0.3);
        doc.fontSize(9).font("Helvetica-Bold")
            .text("Total Deductions", tableLeft, doc.y, { width: descWidth })
            .text(formatCurrency(totalDeductions, currency), colAmt, doc.y, { width: amtWidth, align: "right" });
        doc.moveDown(1);

        // ── NET PAY ──
        const netPayY = doc.y;
        doc.rect(tableLeft, netPayY - 5, descWidth + amtWidth + 10, 25).fill("#F0F0F0");
        doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000")
            .text("NET PAY", tableLeft + 5, netPayY, { width: descWidth })
            .text(formatCurrency(totalEarnings - totalDeductions, currency), colAmt, netPayY, { width: amtWidth, align: "right" });
        doc.moveDown(1.5);

        // ── PRORATION NOTE ──
        if (payslip.prorationFactor && payslip.prorationFactor < 1) {
            doc.fontSize(8).font("Helvetica-Oblique").fillColor("#666666")
                .text(`Note: Salary prorated to ${(payslip.prorationFactor * 100).toFixed(1)}% of full period.`, tableLeft);
            doc.moveDown(0.5);
        }

        // ── FOOTER ──
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke("#999999");
        doc.moveDown(0.3);
        doc.fontSize(7).font("Helvetica").fillColor("#999999")
            .text("This is a system-generated payslip. For queries, contact HR.", tableLeft, doc.y, { align: "center", width: 515 });
        if (payslip.ruleVersion) {
            doc.text(`Rule: ${payslip.ruleVersion}`, tableLeft, doc.y + 2, { align: "center", width: 515 });
        }

        doc.end();
    });
};

const formatCurrency = (amount, currency = "PKR") => {
    return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
