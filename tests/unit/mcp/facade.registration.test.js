// tests/unit/mcp/facade.registration.test.js
//
// M1-HR / ARCH-05 §4,§12 — the hr_ MCP facade must register cleanly across ALL
// HR entity families and be deny-by-default permission-gated. This smoke test
// builds the real MCP server (the same one /mcp serves) and asserts:
//   * every tool file registers without throwing,
//   * a broad facade surface is present (>120 tools/resources across families),
//   * representative mutating tools exist for the fanned-out domains.
import { describe, it, expect } from '@jest/globals';

import { getMcpServer } from '../../../src/mcp/mcpServer.js';

// The MCP SDK stores registered tools/resources on private maps; we capture the
// registered NAMES by spying through a thin recording server instead.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../../../src/mcp/toolRegistry.js';

function collectFacadeNames() {
    const names = { tools: [], resources: [] };
    const recording = new McpServer({ name: 'rec', version: '0' });
    const origTool = recording.tool.bind(recording);
    const origResource = recording.resource.bind(recording);
    recording.tool = (name, ...rest) => { names.tools.push(name); return origTool(name, ...rest); };
    recording.resource = (name, ...rest) => { names.resources.push(name); return origResource(name, ...rest); };
    registerAllTools(recording);
    return names;
}

describe('hr_ MCP facade registration', () => {
    it('builds the real /mcp server without throwing', () => {
        expect(() => getMcpServer()).not.toThrow();
    });

    it('registers a broad facade surface across all HR entity families', () => {
        const { tools, resources } = collectFacadeNames();
        const all = [...tools, ...resources];
        // A comprehensive facade — guards against a tool file silently dropping.
        expect(all.length).toBeGreaterThan(120);
        // every name is hr_-prefixed (namespace discipline)
        expect(all.every((n) => n.startsWith('hr_'))).toBe(true);

        // each fanned-out domain has a representative mutating tool present
        for (const t of [
            'hr_employee_update',
            'hr_leave_request_approve',
            'hr_payroll_run_finalize',
            'hr_attendance_checkin',
            'hr_offer_send',
            'hr_performance_review_update',
        ]) {
            expect(tools).toContain(t);
        }
    });
});
