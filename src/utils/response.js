// src/utils/response.js
export const sendSuccess = (res, data, message = 'Success', statusCode = 200) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data
    });
};

export const sendError = (res, message = 'Error', statusCode = 500) => {
    return res.status(statusCode).json({
        success: false,
        message
    });
};