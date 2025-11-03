// tests/integration/payrollRoutes.test.js
const request = require('supertest');
const app = require('../../app.js');
const { prisma } = require('../setup.js');
const testHelpers = require('../testHelpers.js');

describe('Payroll Routes - Integration Tests', function () {
    var authToken;
    var testUser;
    var testEmployee;
    var testPayrollRun;

    beforeAll(function (done) {
        testUser = testHelpers.createTestUser();
        authToken = testHelpers.createTestToken(testUser);

        prisma.employee.create({
            data: testHelpers.createTestEmployee()
        }).then(function (employee) {
            testEmployee = employee;
            done();
        }).catch(done);
    });

    beforeEach(function (done) {
        prisma.payrollRun.create({
            data: testHelpers.createTestPayrollRun()
        }).then(function (payrollRun) {
            testPayrollRun = payrollRun;
            return Promise.all([
                prisma.employmentTerms.create({
                    data: testHelpers.createTestEmploymentTerms(testEmployee.id)
                }),
                prisma.payrollEarningType.create({
                    data: testHelpers.createTestEarningType()
                }),
                prisma.payrollDeductionType.create({
                    data: testHelpers.createTestDeductionType()
                }),
                prisma.taxRate.create({
                    data: testHelpers.createTestTaxRate()
                })
            ]);
        }).then(function () {
            done();
        }).catch(done);
    });

    describe('GET /api/payroll/runs', function () {
        test('should return list of payroll runs', function (done) {
            request(app)
                .get('/api/payroll/runs')
                .set('Authorization', 'Bearer ' + authToken)
                .expect(200)
                .end(function (err, response) {
                    if (err) return done(err);
                    expect(response.body.success).toBe(true);
                    expect(response.body.data.runs).toHaveLength(1);
                    done();
                });
        });
    });
});