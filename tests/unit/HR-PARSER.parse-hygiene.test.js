// HR-PARSER — parse-hygiene gate for src/**/*.js
//
// Commit 7852915 ("add tenantId to all remaining logAction calls across 30
// service files") dropped one line into hr.service.js without the `//`
// prefix inside a commented-out block. That single live line parsed as a
// top-level LabeledStatement whose trailing comma swallowed the following
// `function calculateTenure` into a nameless FunctionExpression — so the
// identifier never existed and every createEmployeeService call threw
// ReferenceError at runtime. The file still parsed, so nothing caught it.
//
// This gate fails ANY src file that produces a top-level LabeledStatement
// (the signature of a stray "key: value" line outside an object literal) or
// a top-level SequenceExpression statement (the signature of a stray
// comma-led fragment). Both are always bugs in this codebase's style.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { describe, it, expect } from '@jest/globals';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', '..', 'src');

function listJsFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        stack.push(p);
      } else if (ent.name.endsWith('.js')) {
        out.push(p);
        if (out.length > 5000) throw new Error('src scan exceeded 5000 files');
      }
    }
  }
  return out;
}

describe('HR-PARSER parse hygiene — no stray top-level labeled statements', () => {
  it('every src/**/*.js parses clean (no top-level LabeledStatement / SequenceExpression statements)', () => {
    const files = listJsFiles(SRC);
    expect(files.length).toBeGreaterThan(50);

    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      let ast;
      try {
        ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
      } catch (e) {
        offenders.push(`${f}: PARSE ERROR ${e.message}`);
        continue;
      }
      const bad = [];
      // Top-level statements only: direct children of Program. A stray
      // `key: value,` line lands here as a LabeledStatement; a stray comma
      // fragment lands as an ExpressionStatement wrapping a SequenceExpression.
      for (const stmt of ast.body) {
        if (stmt.type === 'LabeledStatement') {
          bad.push(`top-level LabeledStatement @ line ${stmt.loc.start.line}: ${JSON.stringify(src.slice(stmt.start, stmt.start + 60))}`);
        }
        if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'SequenceExpression') {
          bad.push(`top-level SequenceExpression @ line ${stmt.loc.start.line}: ${JSON.stringify(src.slice(stmt.start, stmt.start + 60))}`);
        }
      }
      if (bad.length) offenders.push(`${f.replace(SRC, 'src')}\n    ${bad.join('\n    ')}`);
    }

    expect(offenders).toEqual([]);
  });
});
