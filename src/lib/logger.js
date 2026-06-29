// src/lib/logger.js — single pino logger for the HR service.
//
// Per BE-§7.1 the service must emit structured logs (no bare console.*)
// so the gateway and ops dashboards can parse them. This is the
// foundation; controllers/services switch over to it incrementally.
//
// LOG_LEVEL env (default 'info') controls verbosity. Pretty output is
// opt-in via LOG_PRETTY=1 so production stays as ndjson.
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

const options = {
    level,
    base: {
        service: 'erp-hr-backend',
        env: process.env.NODE_ENV || 'development',
    },
    redact: {
        // HR-01 / T-P4.2 — C4 (most-sensitive) fields are added to the pino
        // redaction surface so a structured log line that happens to carry a
        // salary / bank account / national id never emits it in plaintext.
        // pino's `*.<field>` matches the field one level deep on any object; we
        // also cover the bare top-level key. Audit-diff JSON blobs (which do
        // not flow through pino) are handled separately by src/lib/c4Redaction.js.
        paths: [
            'req.headers.authorization',
            'req.headers["x-internal-secret"]',
            'req.headers["x-service-authorization"]',
            'req.headers.cookie',
            '*.password',
            '*.token',
            // C4: salary / compensation
            'baseSalary',
            'bonusTarget',
            'salary',
            'grossAmount',
            'netAmount',
            'totalDeductions',
            '*.baseSalary',
            '*.bonusTarget',
            '*.salary',
            '*.grossAmount',
            '*.netAmount',
            '*.totalDeductions',
            // C4: bank
            'accountNumber',
            'routingNumber',
            '*.accountNumber',
            '*.routingNumber',
            // C4: national id
            'nationality_id_no',
            '*.nationality_id_no',
        ],
        censor: '[REDACTED]',
    },
};

let logger;
if (process.env.LOG_PRETTY === '1') {
    // pino-pretty is dev-only; if it isn't installed, fall back gracefully.
    try {
        logger = pino({
            ...options,
            transport: { target: 'pino-pretty', options: { colorize: true } },
        });
    } catch {
        logger = pino(options);
    }
} else {
    logger = pino(options);
}

export default logger;
