/**
 * IC-15 — HR analytics MCP RESOURCE path is broken.
 *
 * Bug #1: `hr://analytics/dashboards/overview` throws
 *   "utils.generatePositionAlerts is not a function" because the
 *   department→position (D-12) rename updated the call sites in
 *   analyticsService.js but never renamed/aliased the util in
 *   analyticsUtils.js (only `generateDepartmentAlerts` exists).
 *
 * These tests assert the util exists, is exported, and produces the same
 * shape as the legacy alert generator.
 */
import * as utils from '../../src/utils/analyticsUtils.js';

describe('IC-15 — analytics util parity (generatePositionAlerts)', () => {
  test('generatePositionAlerts is an exported function', () => {
    expect(typeof utils.generatePositionAlerts).toBe('function');
  });

  test('returns the same alerts as generateDepartmentAlerts (alias parity)', () => {
    const metrics = { turnoverRate: 20, absenteeismRate: 8, performance: 2.5 };
    expect(utils.generatePositionAlerts(metrics)).toEqual(
      utils.generateDepartmentAlerts(metrics)
    );
  });

  test('flags HIGH_TURNOVER above the 15% threshold', () => {
    const alerts = utils.generatePositionAlerts({ turnoverRate: 20, absenteeismRate: 0, performance: 4 });
    expect(alerts.some((a) => a.type === 'HIGH_TURNOVER')).toBe(true);
  });

  test('returns an empty array when all metrics are healthy', () => {
    const alerts = utils.generatePositionAlerts({ turnoverRate: 1, absenteeismRate: 1, performance: 4.5 });
    expect(alerts).toEqual([]);
  });
});
