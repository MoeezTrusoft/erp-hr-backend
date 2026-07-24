// src/lib/payrollFormula.js
//
// Safe expression evaluator for Payroll Setup salary-component formulas.
// Formulas are AUTHOR-SUPPLIED config (e.g. "BASIC * 0.4", "min(GROSS*0.1, 5000)",
// "(BASIC + HRA) * 0.1"), so they MUST NOT be evaluated with eval()/Function().
//
// This is a tiny recursive-descent parser + evaluator over a whitelisted grammar:
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/' | '%') factor)*
//   factor := ('+' | '-') factor | primary
//   primary:= NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')'
// Only these functions are callable; nothing else (no property access, no globals):
const FUNCTIONS = {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  round: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; },
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  abs: (x) => Math.abs(x),
  pow: (x, y) => x ** y,
};

// Identifiers: component codes / variables like BASIC, GROSS, DAYS_WORKED.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src ?? "");
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if ("+-*/%(),".includes(c)) { tokens.push({ t: c }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = s.slice(i, j);
      if ((num.match(/\./g) || []).length > 1) throw new Error(`bad number "${num}"`);
      tokens.push({ t: "num", v: Number(num) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      tokens.push({ t: "ident", v: s.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character "${c}" at ${i}`);
  }
  return tokens;
}

function makeParser(tokens, resolve) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t) => { const tok = next(); if (!tok || tok.t !== t) throw new Error(`expected "${t}"`); return tok; };

  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().t === "+" || peek().t === "-")) {
      const op = next().t;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    while (peek() && (peek().t === "*" || peek().t === "/" || peek().t === "%")) {
      const op = next().t;
      const right = parseFactor();
      if (op === "*") left = left * right;
      else if (op === "/") { if (right === 0) throw new Error("division by zero"); left = left / right; }
      else { if (right === 0) throw new Error("modulo by zero"); left = left % right; }
    }
    return left;
  }
  function parseFactor() {
    const tok = peek();
    if (tok && (tok.t === "+" || tok.t === "-")) { next(); const v = parseFactor(); return tok.t === "-" ? -v : v; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = next();
    if (!tok) throw new Error("unexpected end of formula");
    if (tok.t === "num") return tok.v;
    if (tok.t === "(") { const v = parseExpr(); expect(")"); return v; }
    if (tok.t === "ident") {
      if (peek() && peek().t === "(") {
        next(); // consume '('
        const fn = FUNCTIONS[tok.v.toLowerCase()];
        if (!fn) throw new Error(`unknown function "${tok.v}"`);
        const args = [];
        if (peek() && peek().t !== ")") {
          args.push(parseExpr());
          while (peek() && peek().t === ",") { next(); args.push(parseExpr()); }
        }
        expect(")");
        return fn(...args);
      }
      const val = resolve(tok.v);
      if (typeof val !== "number" || Number.isNaN(val)) throw new Error(`unknown or non-numeric variable "${tok.v}"`);
      return val;
    }
    throw new Error(`unexpected token "${tok.t}"`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("trailing tokens in formula");
  return result;
}

/**
 * Evaluate a salary-component formula against a variable scope.
 * @param {string} formula e.g. "BASIC * 0.4"
 * @param {Record<string, number>} scope variable name -> numeric value (case-insensitive)
 * @returns {number}
 * @throws on parse error, unknown variable, or division/modulo by zero.
 */
export function evaluateFormula(formula, scope = {}) {
  // Case-insensitive variable lookup so "basic" and "BASIC" both resolve.
  const upper = {};
  for (const [k, v] of Object.entries(scope)) upper[String(k).toUpperCase()] = v;
  const resolve = (name) => upper[String(name).toUpperCase()];
  return makeParser(tokenize(formula), resolve);
}

/** Collect the identifier (variable/function) names referenced by a formula. */
export function extractIdentifiers(formula) {
  const idents = new Set();
  const tokens = tokenize(formula);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t === "ident") {
      const isCall = tokens[i + 1] && tokens[i + 1].t === "(";
      if (!isCall) idents.add(tokens[i].v);
    }
  }
  return [...idents];
}

/**
 * Validate a formula parses and (optionally) only references allowed variables.
 * @returns {{ok:boolean, error?:string, identifiers:string[]}}
 */
export function validateFormula(formula, allowedVars = null) {
  try {
    const idents = extractIdentifiers(formula);
    if (allowedVars) {
      const allow = new Set(allowedVars.map((v) => String(v).toUpperCase()));
      const unknown = idents.filter((v) => !allow.has(String(v).toUpperCase()));
      if (unknown.length) return { ok: false, error: `unknown variable(s): ${unknown.join(", ")}`, identifiers: idents };
    }
    // Parse-check with a zero scope (all idents resolve to 0) to catch syntax errors.
    const zeroScope = Object.fromEntries(idents.map((v) => [v, 0]));
    evaluateFormula(formula, zeroScope);
    return { ok: true, identifiers: idents };
  } catch (err) {
    return { ok: false, error: err?.message || "invalid formula", identifiers: [] };
  }
}

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);
export { IDENT_RE };
