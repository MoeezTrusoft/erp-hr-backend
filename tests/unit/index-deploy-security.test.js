import { describe, expect, it } from '@jest/globals';
import { deployIndexes } from '../../scripts/apply-hr-indexes.js';

describe('concurrent index deployment credentials', () => {
  const url = 'postgresql://fixture:private-test-value@127.0.0.1:9/test';
  it('keeps the connection URL out of command arguments', () => {
    let invocation;
    expect(deployIndexes({ env: { DATABASE_DIRECT_URL: url, PATH: '/fixture' },
      run: (...args) => { invocation = args; return { status: 0 }; } })).toBe(0);
    expect(invocation[0]).toBe('psql');
    expect(invocation[1]).toContain('ON_ERROR_STOP=1');
    expect(JSON.stringify(invocation[1])).not.toContain('private-test-value');
    expect(invocation[2].env).toMatchObject({ PGDATABASE: 'test', PGHOST: '127.0.0.1',
      PGPORT: '9', PGUSER: 'fixture', PGPASSWORD: 'private-test-value' });
    expect(invocation[2].env.PATH).toBe('/fixture');
  });
  it('does not propagate executable errors containing connection details', () => {
    const invoke = () => deployIndexes({ env: { DATABASE_URL: url },
      run: () => ({ error: new Error(url) }) });
    expect(invoke).toThrow('could not launch psql');
    try { invoke(); } catch (error) { expect(error.stack).not.toContain('private-test-value'); }
  });
  it('propagates SQL failure and terminated-process status', () => {
    expect(deployIndexes({ env: { DATABASE_URL: url }, run: () => ({ status: 3 }) })).toBe(3);
    expect(deployIndexes({ env: { DATABASE_URL: url }, run: () => ({ status: null }) })).toBe(1);
  });
  it('rejects pooled connections before invoking psql', () => {
    expect(() => deployIndexes({ env: { DATABASE_URL: url + '?pgbouncer=true' },
      run: () => { throw new Error('must not run'); } })).toThrow('not PgBouncer');
  });
  it('requires a configured database', () => {
    expect(() => deployIndexes({ env: {} })).toThrow('requires DATABASE_DIRECT_URL or DATABASE_URL');
  });
  it('decodes URI credentials and preserves explicit TLS settings', () => {
    let childEnv;
    deployIndexes({ env: { DATABASE_URL: 'postgresql://test%40user:p%40ss%3Aword@127.0.0.1:5433/test%2Ddb?sslmode=require&schema=public' },
      run: (_file, _args, options) => { childEnv = options.env; return { status: 0 }; } });
    expect(childEnv).toMatchObject({ PGHOST: '127.0.0.1', PGPORT: '5433', PGDATABASE: 'test-db',
      PGUSER: 'test@user', PGPASSWORD: 'p@ss:word', PGSSLMODE: 'require' });
  });
  it('rejects unsupported parameters instead of ignoring connection policy', () => {
    expect(() => deployIndexes({ env: { DATABASE_URL: url + '?unsupported=value' } })).toThrow('unsupported PostgreSQL');
  });
  it('requires the PostgreSQL protocol', () => {
    expect(() => deployIndexes({ env: { DATABASE_URL: 'https://example.test/db' } })).toThrow('PostgreSQL URL');
  });
  it('does not expose malformed connection input', () => {
    expect(() => deployIndexes({ env: { DATABASE_URL: 'private-test-value' } })).toThrow('invalid PostgreSQL connection URL');
    try { deployIndexes({ env: { DATABASE_URL: 'private-test-value' } }); }
    catch (error) { expect(error.stack).not.toContain('private-test-value'); }
  });
});
