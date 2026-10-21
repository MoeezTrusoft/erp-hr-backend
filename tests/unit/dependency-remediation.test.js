import { test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);

test('HR document extraction and Mammoth CLI retain argument compatibility', async () => {
  const input = new URL('../fixtures/security-document.docx', import.meta.url);
  const buffer = await readFile(input);
  expect((await mammoth.extractRawText({ buffer })).value).toContain('HR dependency verification');
  const cli = path.join(path.dirname(require.resolve('mammoth/package.json')), 'bin/mammoth');
  const invoke = args => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
  const directory = await mkdtemp(path.join(tmpdir(), 'hr-document-security-'));
  try {
    const filename = path.join(directory, 'employee document.docx');
    await writeFile(filename, buffer);
    expect(invoke(['--help'])).toContain('--output-format');
    expect(invoke([filename])).toContain('<p>HR dependency verification</p>');
    expect(invoke([filename, '--output-format', 'markdown'])).toContain('HR dependency verification');
    expect(() => invoke([filename, '--output-format', 'invalid'])).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test('ExcelJS round trips HR rows, formulas and streaming worksheets after UUID upgrade', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hr-spreadsheet-security-'));
  try {
    const filename = path.join(directory, 'payroll.xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useSharedStrings: true });
    const sheet = workbook.addWorksheet('Payroll');
    sheet.addRow(['Employee', 'Hours', 'Rate', 'Total']).commit();
    sheet.addRow(['EMP-001', 8, 125, { formula: 'B2*C2', result: 1000 }]).commit();
    await workbook.commit();
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.readFile(filename);
    const values = restored.getWorksheet('Payroll');
    expect(values.getCell('A2').value).toBe('EMP-001');
    expect(values.getCell('D2').value).toEqual({ formula: 'B2*C2', result: 1000 });
    expect(values.rowCount).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test('NYC loads YAML through the maintained parser and its CLI reports its version', async () => {
  const scoped = createRequire(require.resolve('@istanbuljs/load-nyc-config'));
  const yaml = scoped('js-yaml');
  expect(yaml.load('all: true\nextension: [".js"]')).toEqual({ all: true, extension: ['.js'] });
  const cli = path.join(path.dirname(scoped.resolve('js-yaml/package.json')), 'bin/js-yaml.js');
  expect(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 15000 }).trim()).toMatch(/^4\./);
  const directory = await mkdtemp(path.join(tmpdir(), 'hr-nyc-security-'));
  try {
    await writeFile(path.join(directory, '.nycrc.yml'), 'all: true\nextension: [".js"]\n');
    const { loadNycConfig } = require('@istanbuljs/load-nyc-config');
    expect(await loadNycConfig({ cwd: directory })).toMatchObject({ all: true, extension: ['.js'] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
