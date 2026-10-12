import { describe, it, expect } from '@jest/globals';
import { receiveCapture } from '../../src/services/attendanceCapture.service.js';
import { mcpCtx } from '../../src/mcp/context.js';
import { captureDb } from '../helpers/captureDb.js';
describe('capture async-local context', () => {
  it('awaits every lazy query inside the SYSTEM transaction context', async () => {
    const db = captureDb(); const executions = [];
    for (const [model, delegate] of Object.entries(db)) {
      if (!delegate || typeof delegate !== 'object') continue;
      for (const [name, fn] of Object.entries(delegate)) {
        if (typeof fn !== 'function') continue;
        delegate[name] = args => ({ then(resolve, reject) {
          executions.push({ model, name, system: mcpCtx.getStore()?.system });
          if (!mcpCtx.getStore()?.system) return reject(new Error('Query escaped its context'));
          return fn(args).then(resolve, reject);
        } });
      }
    }
    await receiveCapture({ sn: 'DEVICE-1', rows: ['101\t2026-10-01 09:00:00\t0'] }, db);
    expect(executions.length).toBeGreaterThan(5);
    expect(executions.every(e => e.system)).toBe(true);
    expect(mcpCtx.getStore()).toBeUndefined();
  });
});
