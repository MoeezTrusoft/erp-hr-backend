import { describe, it, expect } from '@jest/globals';
import { assertRequiredDatabaseReady } from '../helpers/required-database.js';

const env = { NODE_ENV: 'test', CROSS_SERVICE_DISPOSABLE: '1', DATABASE_URL: 'postgresql://fixture:unused@127.0.0.1/hr_regression_test' };
describe('mandatory disposable HR database checks', () => {
    it('accepts a ready isolated fixture', () => expect(() => assertRequiredDatabaseReady(true, env)).not.toThrow());
    it('fails when database setup was silently caught by a legacy suite', () => expect(() => assertRequiredDatabaseReady(false, env)).toThrow(/did not initialize/));
    it.each([
        { NODE_ENV: 'production' },
        { DATABASE_URL: 'postgresql://fixture:unused@remote.invalid/hr_regression_test' },
        { DATABASE_URL: 'postgresql://fixture:unused@127.0.0.1/erp-hr' },
    ])('rejects a non-fixture environment %j', override => expect(() => assertRequiredDatabaseReady(true, { ...env, ...override })).toThrow());
    it('retains the optional local lane', () => expect(() => assertRequiredDatabaseReady(false, {})).not.toThrow());
});
