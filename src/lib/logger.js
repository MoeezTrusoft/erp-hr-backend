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
        paths: [
            'req.headers.authorization',
            'req.headers["x-internal-secret"]',
            'req.headers.cookie',
            '*.password',
            '*.token',
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
