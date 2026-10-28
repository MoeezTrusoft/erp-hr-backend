import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const merge = require('deepmerge');

test('deepmerge cannot poison returned prototypes through source or target keys', () => {
  const jestRequire = createRequire(require.resolve('jest-config/package.json'));
  assert.equal(jestRequire('deepmerge'), merge, 'Jest must resolve the patched dependency');
  const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
  for (const target of [{}, Object.create(null), malicious]) {
    for (const source of [{}, malicious]) {
      const result = merge(target, source);
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.equal(result.polluted, undefined);
      assert.equal({}.polluted, undefined);
    }
  }
  const constructor = merge({}, JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'));
  assert.equal(constructor.polluted, undefined);
  assert.equal({}.polluted, undefined);
});
test('deepmerge preserves array, nested object, symbol and custom merge contracts', () => {
  const symbol = Symbol('data');
  const original = { nested: { a: 1 }, items: [1], [symbol]: { a: 1 } };
  const result = merge(original, { nested: { b: 2 }, items: [2], [symbol]: { b: 2 } });
  assert.deepEqual(result, { nested: { a: 1, b: 2 }, items: [1, 2], [symbol]: { a: 1, b: 2 } });
  assert.notEqual(result.nested, original.nested);
  assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
  assert.deepEqual(merge({ items: [1] }, { items: [2] }, { arrayMerge: (_a, b) => b }), { items: [2] });
});
test('ExcelJS writes and reads conditional formatting with its patched UUID dependency', async () => {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Appraisals');
  sheet.addRow(['Employee', 'Score']);
  sheet.addRow(['TEST-001', 75]);
  sheet.addConditionalFormatting({ ref: 'B2', rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }] }] });
  const buffer = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(buffer);
  assert.equal(restored.getWorksheet('Appraisals').getCell('B2').value, 75);
});
