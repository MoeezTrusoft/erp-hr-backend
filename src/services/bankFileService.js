// src/services/bankFileService.js — HR-BANKFILE-03 / HR-PAY-04
//
// Generate a bank/ACH disbursement file from a FINALIZED PayrollRun. For each
// employee's payslip we emit one disbursement row: their (in-memory decrypted)
// primary bank account + routing + the NET pay. The file is produced in a
// selectable format (NACHA ACH or a configurable bank CSV — see
// src/lib/bankFileFormats.js, which is the extension point for more formats).
//
// SECURITY CONTRACT (the parts this module OWNS):
//   * Tenant scope — every query folds the VERIFIED tenant via withTenant, so a
//     wrong-tenant run id resolves to not-found (the controller maps to 404),
//     never another tenant's payroll.
//   * Status gate — only FINALIZED runs are exportable; DRAFT/PROCESSING/etc.
//     are rejected (the run is not yet locked for distribution).
//   * C4 decryption is IN-MEMORY ONLY — bank account/routing numbers are
//     c4-encrypted at rest and transparently decrypted by the prisma C4
//     extension on read. They live only inside the returned file `content`.
//     They are NEVER logged: structured logs and the audit row carry counts,
//     totals and a MASKED account (last-4) only — never the plaintext.
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { logAction } from '../utils/logs.js';
import * as money from '../lib/money.js';
import { withTenant } from '../lib/tenancy.js';
import { FORMATTERS, isSupportedFormat } from '../lib/bankFileFormats.js';

const fail = (status, code, message) =>
    Object.assign(new Error(message), { status, statusCode: status, code });

// last-4 masking for anything that touches a log/audit sink. Never emit the
// full account number — only enough to correlate a disbursement to a row.
export const maskAccount = (acct) => {
    const s = String(acct ?? '');
    if (s.length <= 4) return '****';
    return `****${s.slice(-4)}`;
};

const primaryBankOf = (employee) => {
    const banks = employee?.bankDetails ?? [];
    return banks.find((b) => b.isPrimary) ?? banks[0] ?? null;
};

/**
 * Generate a bank disbursement file for a FINALIZED payroll run.
 *
 * @param {number} runId
 * @param {object} args
 * @param {string|null} args.tenantId  VERIFIED RBAC Company.uuid (req.user.tenantId)
 * @param {string} [args.format='nacha']  'nacha' | 'ach' | 'csv'
 * @param {object} [args.origin]  originator/bank config threaded into the format
 * @param {number|null} [args.actorId]  audit actor (employee id)
 * @returns {Promise<{format,filename,contentType,content,summary}>}
 */
export const generateBankDisbursementFile = async (
    runId,
    { tenantId, format = 'nacha', origin = {}, actorId = null } = {},
) => {
    const fmt = String(format).toLowerCase();
    if (!isSupportedFormat(fmt)) {
        throw fail(400, 'HR-1213', `Unsupported bank file format '${format}' (supported: ${Object.keys(FORMATTERS).join(', ')})`);
    }

    // Tenant-scoped single read: a cross-tenant id resolves to null → 404.
    const run = await prisma.payrollRun.findFirst({
        where: withTenant(tenantId, { id: runId }),
    });
    if (!run) {
        throw fail(404, 'HR-1210', `Payroll run ${runId} not found`);
    }
    if (run.status !== 'FINALIZED') {
        throw fail(409, 'HR-1211', `Payroll run ${runId} is ${run.status}; only FINALIZED runs are exportable`);
    }

    // Payslips for the run, tenant-scoped. The employee's bank details are
    // c4-encrypted at rest and decrypted to plaintext by the prisma extension on
    // this read (in-memory only).
    const payslips = await prisma.payrollPayslip.findMany({
        where: withTenant(tenantId, { payrollRunId: runId }),
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    employee_name: true,
                    bankDetails: {
                        select: {
                            accountNumber: true,
                            routingNumber: true,
                            accountType: true,
                            isPrimary: true,
                            bankName: true,
                        },
                    },
                },
            },
        },
        orderBy: { employeeId: 'asc' },
    });

    const rows = [];
    const missing = [];
    for (const slip of payslips) {
        const amountMinor = money.fromMajor(slip.netAmount);
        if (amountMinor <= 0) continue; // nothing to disburse (zero/negative net)

        const emp = slip.employee ?? {};
        const bank = primaryBankOf(emp);
        if (!bank || !bank.accountNumber || !bank.routingNumber) {
            missing.push(emp.id ?? slip.employeeId); // ids only — never account data
            continue;
        }

        const name =
            emp.employee_name ||
            [emp.first_name, emp.last_name].filter(Boolean).join(' ') ||
            `EMP ${emp.id ?? slip.employeeId}`;

        rows.push({
            employeeId: emp.id ?? slip.employeeId,
            name,
            routingNumber: bank.routingNumber,
            accountNumber: bank.accountNumber,
            accountType: bank.accountType || 'CHECKING',
            amountMinor,
            currency: run.currencyCode || 'USD',
        });
    }

    if (missing.length > 0) {
        throw fail(
            422,
            'HR-1212',
            `Cannot generate disbursement file: ${missing.length} employee(s) missing bank account/routing details (employee ids: ${missing.join(', ')})`,
        );
    }

    const descriptor = FORMATTERS[fmt];
    const opts = {
        companyName: origin.companyName || run.tenantId || 'COMPANY',
        companyId: origin.companyId,
        originName: origin.originName,
        originatingDfi: origin.originatingDfi,
        immediateDestination: origin.immediateDestination,
        immediateOrigin: origin.immediateOrigin,
        entryDescription: origin.entryDescription || 'PAYROLL',
        effectiveDate: origin.effectiveDate || run.periodEnd,
        currency: run.currencyCode || 'USD',
    };
    const content = descriptor.build(rows, opts);

    const totalMinor = rows.reduce((acc, r) => acc + r.amountMinor, 0);
    const filename = `disbursement-run-${runId}.${descriptor.ext}`;

    // STRUCTURED LOG — counts + totals + MASKED accounts only. The full account
    // numbers live exclusively in `content`; they never reach a log sink.
    logger.info(
        {
            event: 'bank_disbursement_file_generated',
            runId,
            tenantId,
            format: fmt,
            rowCount: rows.length,
            totalMinor,
            accountsMasked: rows.map((r) => maskAccount(r.accountNumber)),
        },
        'bank disbursement file generated',
    );

    // AUDIT — describes WHAT was exported, never the decrypted values.
    await logAction({
        employeeId: actorId != null ? Number(actorId) : null,
        actionById: actorId != null ? Number(actorId) : null,
        type: 'BankDisbursementExport',
        module: 'Payroll Run',
        result: 'SUCCESS',
        notes: `Bank disbursement file (${fmt}) generated for payroll run ${runId}: ${rows.length} disbursement(s)`,
    }).catch((e) => logger.warn({ err: e?.message, runId }, 'bank disbursement audit log failed'));

    return {
        format: fmt,
        filename,
        contentType: descriptor.contentType,
        content,
        summary: {
            runId,
            rowCount: rows.length,
            totalMinor,
            currency: run.currencyCode || 'USD',
        },
    };
};

export default { generateBankDisbursementFile, maskAccount };
