// tests/unit/mcp/toolRegistry.no-duplicates.test.js
//
// T-FIX — a duplicate tool name is not a cosmetic issue: the MCP SDK THROWS at
// registration time ("Tool X is already registered"), and because registration
// happens inside per-request server construction, ONE duplicate kills EVERY
// MCP call on the service — login on RBAC (rbac_user_directory_list, 2026-09-14)
// and all HR tool traffic (hr_holiday_create, registered by both
// holidayCalendarTools.js and leaveTools.js). Per-file scenario tests could not
// see this: their Map-based recorder silently overwrites duplicates. This test
// registers the REAL registry into an SDK-faithful recorder that throws.
import { jest, describe, it, expect } from '@jest/globals';

// The full registry transitively imports nearly every service; give the heavy
// shared seams harmless fakes so registration logic itself is what's exercised.
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }),
}));

const { registerAllTools } = await import('../../../src/mcp/toolRegistry.js');

describe('TOOL-REGISTRY — no duplicate registrations (SDK throws on them)', () => {
  it('every tool/resource name registers exactly once within its own kind', () => {
    // Tools and resources live in SEPARATE SDK registries, so a resource and a
    // tool may share a name (hr_attendance_list etc. — long-standing pattern).
    // A collision only breaks production when the SAME kind doubles a name.
    const seenTool = new Map();
    const seenResource = new Map();
    const dupes = [];
    const record = (seen, kind) => (name) => {
      if (seen.has(name)) dupes.push(`${kind}:${name}`);
      seen.set(name, true);
    };
    const recorder = {
      tool: record(seenTool, 'tool'),
      resource: record(seenResource, 'resource'),
    };

    expect(() => registerAllTools(recorder)).not.toThrow();
    expect(dupes).toEqual([]);
    // Sanity: the registry actually registered the fleet, not nothing.
    expect(seenTool.size).toBeGreaterThan(50);
    // The names that already bit us once stay pinned as tools.
    expect(seenTool.get('hr_holiday_create')).toBe(true);
    expect(seenTool.get('hr_anomaly_create')).toBe(true);
  });
});
