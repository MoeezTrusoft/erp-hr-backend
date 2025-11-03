// tests/mocks/payrollServiceMock.js
module.exports = {
    calculateBaseSalary: function (annualSalary, payFrequency) {
        if (payFrequency === 'MONTHLY') {
            return annualSalary / 12;
        } else if (payFrequency === 'WEEKLY') {
            return annualSalary / 52;
        } else if (payFrequency === 'BI_WEEKLY') {
            return annualSalary / 26;
        } else if (payFrequency === 'SEMI_MONTHLY') {
            return annualSalary / 24;
        }
        return annualSalary / 12; // default monthly
    },

    calculateTaxAmount: function (taxableIncome, taxRates) {
        var taxAmount = 0;
        var remainingIncome = taxableIncome;

        for (var i = 0; i < taxRates.length; i++) {
            var rate = taxRates[i];
            if (remainingIncome <= 0) break;

            // Calculate the range for this bracket
            var bracketMin = rate.bracketMin;
            var bracketMax = rate.bracketMax || Infinity;

            // Income that falls into this bracket
            var incomeInBracket = Math.min(remainingIncome, bracketMax - bracketMin);

            if (incomeInBracket > 0) {
                taxAmount += incomeInBracket * rate.rate;
                remainingIncome -= incomeInBracket;
            }
        }

        return taxAmount;
    },

    createPayrollRunService: function (data, user) {
        return Promise.resolve({
            id: 1,
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
            countryCode: data.countryCode,
            currencyCode: data.currencyCode,
            status: 'PENDING'
        });
    }
};