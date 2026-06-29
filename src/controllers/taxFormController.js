// src/controllers/taxFormController.js — HR-PAY-07 / HR-SEC-05
//
// HTTP surface for statutory year-end tax forms (W-2 / 1099-NEC). Both routes
// are mounted on the C4 payroll surface in payrollRoutes.js behind
// requirePermission('hr:payroll') (deny-by-default), and every read is tenant
// scoped via req.user.tenantId (the VERIFIED service-JWT claim — never a
// header). The generation materializes decrypted C4 (SSN/EIN); we record the
// auditable C4 read (notes carry no identifiers — see auditC4Read + service).
import * as taxFormService from '../services/taxFormService.js';
import { auditC4Read } from '../lib/c4Access.js';

// Single source of truth for the tenant (HR-04 / T-P2.2): the VERIFIED claim on
// req.user.tenantId, NEVER the spoofable x-tenant-id header.
const tenantOf = (req) => req.user?.tenantId ?? null;
const actorOf = (req) => req.user?.employeeId ?? req.user?.userId ?? null;

const mapStatus = (error) => error.status || error.statusCode || 500;

// GET /api/payroll/tax-forms/:taxYear — structured W-2 + 1099-NEC data.
export const getYearEndTaxForms = async (req, res) => {
    try {
        const result = await taxFormService.generateYearEndTaxForms(req.params.taxYear, {
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });

        await auditC4Read(req.user, { action: 'TAX_FORMS_READ', target: req.params.taxYear });

        res.json({ success: true, data: result });
    } catch (error) {
        res.status(mapStatus(error)).json({ success: false, error: error.message, code: error.code });
    }
};

// GET /api/payroll/tax-forms/:taxYear/export?formType=w2|1099&format=csv
export const exportYearEndTaxForms = async (req, res) => {
    try {
        const result = await taxFormService.exportYearEndTaxForms(req.params.taxYear, {
            tenantId: tenantOf(req),
            formType: req.query.formType ?? req.query.form ?? 'w2',
            format: (req.query.format || 'csv').toLowerCase(),
            actorId: actorOf(req),
        });

        await auditC4Read(req.user, { action: 'TAX_FORMS_EXPORT', target: req.params.taxYear });

        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.setHeader('X-Tax-Form-Type', result.formType);
        res.setHeader('X-Tax-Form-Count', String(result.summary.exportedCount));
        return res.status(200).send(result.content);
    } catch (error) {
        return res.status(mapStatus(error)).json({ success: false, error: error.message, code: error.code });
    }
};

export default { getYearEndTaxForms, exportYearEndTaxForms };
