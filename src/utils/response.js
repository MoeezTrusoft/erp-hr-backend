// src/utils/response.js
import { GENERIC_INTERNAL, HR_ERRORS } from '../constants/errorCodes.js';

export const sendSuccess = (res, data, message = 'Success', statusCode = 200) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        meta: {},
        requestId: res.req?.requestId
    });
};

// ERR-3: 5xx responses NEVER carry the caller-supplied (possibly raw Prisma/RLS)
// message. Any statusCode >= 500 is genericized to the fixed HR-5000 message +
// code; the real error is expected to have been logged server-side by the
// caller (controllers now route unexpected errors through respondServerError /
// the terminal handler, which log the full error). 4xx messages are client-safe
// and preserved.
export const sendError = (res, message = 'Error', statusCode = 500, errors = []) => {
    const isServer = statusCode >= 500;
    const safeMessage = isServer ? GENERIC_INTERNAL.message : message;
    const defaultCode = isServer ? GENERIC_INTERNAL.code : HR_ERRORS.BAD_REQUEST.code;
    const safeErrors = isServer
        ? [{ code: defaultCode, message: safeMessage }]
        : (errors.length ? errors : [{ code: defaultCode, message: safeMessage }]);
    return res.status(statusCode).json({
        success: false,
        message: safeMessage,
        errors: safeErrors,
        requestId: res.req?.requestId
    });
};
