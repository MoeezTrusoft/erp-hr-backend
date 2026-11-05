import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import ExcelJS from 'exceljs';
import {v4, validate, NIL} from 'uuid';
const require = createRequire(import.meta.url);

test('UUID retains ESM and CommonJS validation and generation APIs', () => {
  assert.ok(validate(v4()));
  assert.ok(validate(require('uuid').v4()));
  assert.ok(validate(NIL));
  assert.equal(validate('invalid-tenant'), false);
});

test('ExcelJS extended conditional formatting generates UUIDs and survives XLSX round trip', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Attendance');
  sheet.addRows([['Employee', 'Hours'], ['Fixture', 8], ['Other', 4]]);
  sheet.addConditionalFormatting({ref:'B2:B3', rules:[{
    type:'iconSet', iconSet:'3Stars', cfvo:[{type:'percent',value:0},{type:'percent',value:33},{type:'percent',value:67}]
  }]});
  const bytes = await book.xlsx.writeBuffer();
  const rule = sheet.conditionalFormattings[0].rules[0];
  assert.ok(validate(rule.x14Id.replace(/[{}]/g, '')));
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(bytes);
  assert.equal(loaded.getWorksheet('Attendance').getCell('B2').value, 8);
  assert.equal(loaded.getWorksheet('Attendance').conditionalFormattings[0].rules[0].iconSet, '3Stars');
});
