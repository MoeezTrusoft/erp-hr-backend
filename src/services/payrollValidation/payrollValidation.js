// validations/payrollValidation.js
const Joi = require('joi');

const createPayrollRun = {
    body: Joi.object({
        periodStart: Joi.date().required(),
        periodEnd: Joi.date().required().greater(Joi.ref('periodStart')),
        countryCode: Joi.string().length(2).required(),
        currencyCode: Joi.string().length(3).required()
    })
};

const updatePayrollRun = {
    params: Joi.object({
        id: Joi.number().integer().required()
    }),
    body: Joi.object({
        status: Joi.string().valid('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED')
    })
};

const updatePayslip = {
    params: Joi.object({
        id: Joi.number().integer().required()
    }),
    body: Joi.object({
        status: Joi.string().valid('DRAFT', 'FINALIZED', 'DISTRIBUTED')
    })
};

const createEarningType = {
    body: Joi.object({
        code: Joi.string().required(),
        name: Joi.string().required(),
        description: Joi.string().allow('', null),
        type: Joi.string().valid('EARNING', 'DEDUCTION').default('EARNING'),
        isTaxable: Joi.boolean().default(true)
    })
};

const updateEarningType = {
    params: Joi.object({
        id: Joi.number().integer().required()
    }),
    body: Joi.object({
        name: Joi.string(),
        description: Joi.string().allow('', null),
        isTaxable: Joi.boolean()
    })
};

const createDeductionType = {
    body: Joi.object({
        code: Joi.string().required(),
        name: Joi.string().required(),
        description: Joi.string().allow('', null),
        type: Joi.string().valid('EARNING', 'DEDUCTION').default('DEDUCTION'),
        rate: Joi.number().min(0).max(100).allow(null)
    })
};

const updateDeductionType = {
    params: Joi.object({
        id: Joi.number().integer().required()
    }),
    body: Joi.object({
        name: Joi.string(),
        description: Joi.string().allow('', null),
        rate: Joi.number().min(0).max(100).allow(null)
    })
};

module.exports = {
    createPayrollRun,
    updatePayrollRun,
    updatePayslip,
    createEarningType,
    updateEarningType,
    createDeductionType,
    updateDeductionType
};