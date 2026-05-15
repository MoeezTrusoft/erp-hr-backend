// src/utils/response.js
export const sendSuccess = (res, data, message = 'Success', statusCode = 200) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        meta: {},
        requestId: res.req?.requestId
    });
};

export const sendError = (res, message = 'Error', statusCode = 500, errors = []) => {
    return res.status(statusCode).json({
        success: false,
        message,
        errors: errors.length ? errors : [{ code: 'ERROR', message }],
        requestId: res.req?.requestId
    });
};
