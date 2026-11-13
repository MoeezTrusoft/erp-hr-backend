// The edit employee form could not load the employee's own company, department, position, manager, code and
// category, because the profile header carried names only (issue 182).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'src/services/employeeProfileTabs.service.js'), 'utf8');
const header = source.slice(source.indexOf('async function buildHeader'), source.indexOf('// -------------------------------------------------------------- overview'));

describe('profile header carries the ids the edit form needs', () => {
  test.each(['companyUuid', 'departmentId', 'positionId', 'managerId', 'employeeCategory'])('%s', (key) => {
    expect(header).toContain(`${key}:`);
  });

  test('the employee select reads the columns behind them', () => {
    for (const column of ['businessUnitId: true', 'positionId: true', 'employeeCategory: true', 'tenant_id: true']) {
      expect(source).toContain(column);
    }
  });
});
