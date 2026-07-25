// src/lib/employeeImportTaxonomy.js
//
// Single source of truth for the bulk EMPLOYEE IMPORT: the column contract
// (also used to render the downloadable template), the enum synonym maps, and
// the value normalizers/validators used by the validate→auto-fix→annotate
// engine (employeeImport.service.js). Pure, dependency-free.

// ── Column contract ──────────────────────────────────────────────────────────
// key      sheet header (snake_case) the user fills
// label    friendly, non-technical column title shown to HR in the sheet header
// required hard-required (row errors if blank)
// kind     req | key | opt  (drives template header colour)
// enum     canonical dropdown values (see ENUM_SYNONYMS for the fix map)
// dynamic  a tenant-populated dropdown ("manager"|"grade"|"department"|
//          "position") sourced from the hidden Lists sheet at template-gen time
// group    non-employee-column groups handled specially on commit
//          ("emergency" → EmergencyContacts row, "salary" → EmploymentTerms +
//          auto-segregated SalaryComponents)
// create   the hr_employee_create arg this column maps to (camelCase)
// direct   an Employee column the create contract can't set → post-write patch
// note     hover help shown in the template (plain English, for HR)
export const IMPORT_COLUMNS = [
  { key: "first_name", kind: "req", required: true, label: "First Name", create: "firstName", note: "REQUIRED. Given name. Auto-fixed: trimmed + Title-Cased." },
  { key: "last_name", kind: "req", required: true, label: "Last Name", create: "lastName", note: "REQUIRED. Family name. Auto-fixed: trimmed + Title-Cased." },
  { key: "middle_name", kind: "opt", label: "Middle Name", create: "middleName", note: "Optional." },
  { key: "preferred_name", kind: "opt", label: "Preferred / Nick Name", create: "preferredName", note: "Optional. Display / nickname." },
  { key: "employee_code", kind: "key", label: "Employee Code (ERP)", create: "employeeCode", note: "The internal ERP code for this employee. Must be UNIQUE. Blank → auto-generated. (This is NOT the biometric device ID — that's the next column.)" },
  { key: "biometric_id", kind: "key", label: "Biometric / Device ID", direct: "biometric_id", note: "★ BIOMETRIC KEY. The exact user-ID enrolled on the ZKTeco attendance device so punches auto-map to this employee. Must be UNIQUE. Optional (attendance won't auto-map until set)." },
  { key: "gender", kind: "opt", label: "Gender", enum: ["Male", "Female", "Other"], create: "gender", note: "Pick from the dropdown. Synonyms auto-fixed (M/F → Male/Female)." },
  { key: "date_of_birth", kind: "opt", label: "Date of Birth", date: true, create: "dateOfBirth", note: "Pick a date. YYYY-MM-DD preferred; other formats auto-parsed." },
  { key: "marital_status", kind: "opt", label: "Marital Status", enum: ["Single", "Married", "Divorced", "Widowed"], create: "maritalStatus", note: "Pick from the dropdown." },
  { key: "nationality", kind: "opt", label: "Nationality", create: "nationality", note: "e.g. Pakistani." },
  { key: "national_id_type", kind: "opt", label: "National ID Type", enum: ["CNIC", "Passport", "Driving License", "Other"], create: "nationalIdType", note: "Pick from the dropdown." },
  { key: "national_id_number", kind: "opt", label: "National ID Number", create: "nationalIdNumber", note: "e.g. CNIC 35202-1234567-8." },
  { key: "personal_email", kind: "opt", label: "Personal Email", email: true, create: "personalEmail", note: "Validated + lower-cased." },
  { key: "work_email", kind: "opt", label: "Work Email", email: true, unique: true, create: "workEmail", note: "Validated + lower-cased. Must be unique. Used as the login email if a login is created." },
  { key: "mobile_phone", kind: "opt", label: "Mobile Phone", phone: true, create: "mobilePhone", note: "Auto-fixed: spaces/dashes stripped." },
  { key: "work_phone", kind: "opt", label: "Work Phone", phone: true, create: "workPhone", note: "Optional." },
  { key: "current_address", kind: "opt", label: "Current Address", create: "residentialAddress", note: "Optional." },
  { key: "city", kind: "opt", label: "City", create: "city", note: "Optional." },
  { key: "state_province", kind: "opt", label: "State / Province", create: "stateProvince", note: "Optional." },
  { key: "country", kind: "opt", label: "Country", create: "country", note: "Optional. Defaults to Pakistan if blank." },
  { key: "postal_code", kind: "opt", label: "Postal Code", create: "postalCode", note: "Optional." },
  { key: "job_title", kind: "opt", label: "Job Title", create: "jobTitle", note: "Free text, e.g. Software Engineer." },
  { key: "department", kind: "opt", label: "Department", lookup: "department", dynamic: "department", create: "departmentId", note: "Pick from the dropdown (existing departments). Unknown names are flagged with the nearest suggestion." },
  { key: "position", kind: "opt", label: "Position", lookup: "position", dynamic: "position", create: "positionId", note: "Pick from the dropdown (existing positions). Unknown = flagged." },
  { key: "grade", kind: "opt", label: "Grade Level", lookup: "grade", dynamic: "grade", direct: "gradeLevelId", note: "Pick from the dropdown (existing grade levels). Unknown = flagged." },
  { key: "manager", kind: "opt", label: "Manager", lookup: "manager", dynamic: "manager", create: "managerId", note: "Pick the manager from the dropdown — shown as Name (EMP-CODE). Unknown = flagged." },
  { key: "employment_type", kind: "opt", label: "Employment Type", enum: ["Full-time", "Part-time", "Contract", "Intern", "Temporary"], create: "employmentType", note: "Pick from the dropdown. Synonyms auto-fixed (FT/Permanent → Full-time)." },
  { key: "employment_status", kind: "opt", label: "Employment Status", enum: ["Active", "Inactive", "On Leave", "Terminated"], create: "employmentStatus", note: "Pick from the dropdown. Blank defaults to Active." },
  { key: "hire_date", kind: "opt", label: "Hire Date", date: true, create: "hireDate", note: "Pick a date. YYYY-MM-DD preferred." },
  { key: "joining_date", kind: "opt", label: "Joining Date", date: true, create: "joiningDate", note: "Pick a date. YYYY-MM-DD preferred." },
  { key: "probation_end_date", kind: "opt", label: "Probation End Date", date: true, create: "probationEndDate", note: "Pick a date. YYYY-MM-DD preferred." },
  { key: "work_mode", kind: "opt", label: "Work Mode", enum: ["On-site", "Remote", "Hybrid"], direct: "work_mode", note: "Pick from the dropdown. Synonyms auto-fixed (WFH → Remote)." },
  { key: "fte", kind: "opt", label: "FTE (0-1)", create: "fte", note: "Number 0.0–1.0 (1 = full-time). Blank defaults to 1. Out-of-range clamped." },
  { key: "emergency_contact_name", kind: "opt", label: "Emergency Contact Name", group: "emergency", note: "Full name of the emergency contact. Optional." },
  { key: "emergency_contact_relationship", kind: "opt", label: "Emergency Contact Relationship", group: "emergency", enum: ["Spouse", "Parent", "Sibling", "Child", "Friend", "Relative", "Other"], note: "Pick from the dropdown." },
  { key: "emergency_contact_phone", kind: "opt", label: "Emergency Contact Phone", group: "emergency", phone: true, note: "Phone of the emergency contact." },
  { key: "emergency_contact_email", kind: "opt", label: "Emergency Contact Email", group: "emergency", email: true, note: "Email of the emergency contact (optional)." },
  { key: "total_salary", kind: "opt", label: "Total Monthly Salary", group: "salary", money: true, note: "Total gross monthly salary. The system auto-splits it into Basic 45%, House Rent 20%, Transport 15%, Medical 12.5%, Utilities 7.5%." },
  { key: "salary_currency", kind: "opt", label: "Salary Currency", group: "salary", enum: ["PKR", "USD", "EUR", "GBP", "AED", "SAR"], note: "Pick the currency (default PKR)." },
  { key: "create_login", kind: "opt", label: "Create Login? (Yes/No)", enum: ["yes", "no"], create: "createSystemAccount", note: "Pick Yes to give this employee an ERP login. The role and a secure password are assigned automatically." },
  { key: "login_email", kind: "opt", label: "Login Email", email: true, create: "systemEmail", note: "Login email (used only if Create Login = Yes). Blank → uses the Work Email." },
];

// ── Salary auto-segregation ──────────────────────────────────────────────────
// HR enters ONE figure (total monthly salary); the backend segregates it into a
// standard structure. BASIC is stored on EmploymentTerms.baseSalary (the payroll
// engine's base); the rest are EARNING SalaryComponents computed as a PERCENTAGE
// of BASIC. The preview engine computes GROSS = BASIC + Σ(pct/100 · BASIC), so
// each component's stored percent is (pctOfTotal / BASIC_PCT_OF_TOTAL · 100) and
// GROSS reconstructs the entered total exactly.
export const BASIC_PCT_OF_TOTAL = 45;
export const SALARY_SPLIT = [
  { code: "HRA", name: "House Rent Allowance", pctOfTotal: 20 },
  { code: "CONV", name: "Transport Allowance", pctOfTotal: 15 },
  { code: "MED", name: "Medical Allowance", pctOfTotal: 12.5 },
  { code: "UTIL", name: "Utilities Allowance", pctOfTotal: 7.5 },
];
// Percent-of-BASIC to store on each SalaryComponent (see note above).
export const componentPctOfBasic = (pctOfTotal) => (pctOfTotal / BASIC_PCT_OF_TOTAL) * 100;

// Parse a money cell: strip currency symbols / thousands separators / spaces.
export function parseMoney(raw) {
  const c = cleanCell(raw);
  if (c === "") return { value: null, valid: true, blank: true };
  const n = Number(String(c).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n) || n < 0) return { value: null, valid: false };
  return { value: Math.round(n * 100) / 100, valid: true, blank: false };
}

export const IMPORT_HEADERS = IMPORT_COLUMNS.map((c) => c.key);
export const COLUMN_BY_KEY = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c.key, c]));

// Friendly header shown to HR (falls back to the machine key).
export const headerLabel = (c) => c.label || c.key;

// Resolve an uploaded header cell back to a column key. The template now uses
// friendly labels ("First Name") as headers, but older sheets may use the
// snake_case key ("first_name") — accept BOTH (and any punctuation/spacing).
const normHeader = (s) =>
  String(s == null ? "" : s).replace(/[*★]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const HEADER_TO_KEY = (() => {
  const m = {};
  for (const c of IMPORT_COLUMNS) {
    m[normHeader(c.key)] = c.key;
    if (c.label) m[normHeader(c.label)] = c.key;
  }
  return m;
})();
export const headerToKey = (text) => HEADER_TO_KEY[normHeader(text)] || null;

// ── Enum synonym maps (lowercased key → canonical) ───────────────────────────
const syn = (canon, alts) => Object.fromEntries(alts.map((a) => [a.toLowerCase(), canon]));
export const ENUM_SYNONYMS = {
  gender: {
    ...syn("Male", ["male", "m", "man", "boy"]),
    ...syn("Female", ["female", "f", "woman", "girl"]),
    ...syn("Other", ["other", "o", "non-binary", "nonbinary", "nb", "prefer not to say", "n/a"]),
  },
  marital_status: {
    ...syn("Single", ["single", "unmarried", "s"]),
    ...syn("Married", ["married", "m"]),
    ...syn("Divorced", ["divorced", "div"]),
    ...syn("Widowed", ["widowed", "widow", "widower"]),
  },
  national_id_type: {
    ...syn("CNIC", ["cnic", "nic", "national id", "national id card", "id card", "nic card"]),
    ...syn("Passport", ["passport", "ppt", "pp"]),
    ...syn("Driving License", ["driving license", "driving licence", "dl", "license", "licence"]),
    ...syn("Other", ["other", "o"]),
  },
  employment_type: {
    ...syn("Full-time", ["full-time", "full time", "fulltime", "ft", "permanent", "perm", "regular"]),
    ...syn("Part-time", ["part-time", "part time", "parttime", "pt"]),
    ...syn("Contract", ["contract", "contractor", "contractual", "consultant"]),
    ...syn("Intern", ["intern", "internship", "trainee", "apprentice"]),
    ...syn("Temporary", ["temporary", "temp", "casual", "seasonal"]),
  },
  employment_status: {
    ...syn("Active", ["active", "employed", "working", "current", "a"]),
    ...syn("Inactive", ["inactive", "disabled", "suspended"]),
    ...syn("On Leave", ["on leave", "on-leave", "onleave", "leave"]),
    ...syn("Terminated", ["terminated", "resigned", "left", "exited", "separated", "ex-employee", "former"]),
  },
  work_mode: {
    ...syn("On-site", ["on-site", "onsite", "on site", "office", "in-office", "in office"]),
    ...syn("Remote", ["remote", "wfh", "work from home", "home", "telework"]),
    ...syn("Hybrid", ["hybrid", "flexible", "mixed", "flex"]),
  },
  create_login: {
    ...syn("yes", ["yes", "y", "true", "1", "t"]),
    ...syn("no", ["no", "n", "false", "0", "f", ""]),
  },
  emergency_contact_relationship: {
    ...syn("Spouse", ["spouse", "husband", "wife", "partner"]),
    ...syn("Parent", ["parent", "father", "mother", "dad", "mom", "mum", "guardian"]),
    ...syn("Sibling", ["sibling", "brother", "sister", "bro", "sis"]),
    ...syn("Child", ["child", "son", "daughter", "kid"]),
    ...syn("Friend", ["friend", "colleague", "coworker", "co-worker"]),
    ...syn("Relative", ["relative", "uncle", "aunt", "cousin", "nephew", "niece", "in-law", "family"]),
    ...syn("Other", ["other", "o"]),
  },
};

// ── Value helpers ────────────────────────────────────────────────────────────
const BLANKISH = new Set(["", "-", "--", "n/a", "na", "null", "none", "nil", "."]);

export function cleanCell(v) {
  if (v == null) return "";
  // exceljs rich text / hyperlink / formula-result objects
  if (typeof v === "object") {
    if (v.text != null) v = v.text;
    else if (v.result != null) v = v.result;
    else if (v.richText) v = v.richText.map((t) => t.text).join("");
    else if (v.hyperlink != null) v = v.text ?? v.hyperlink;
    else if (v instanceof Date) return v;
    else v = String(v);
  }
  if (v instanceof Date) return v;
  const s = String(v).replace(/\s+/g, " ").trim();
  return BLANKISH.has(s.toLowerCase()) ? "" : s;
}

export const isBlank = (v) => cleanCell(v) === "";

export function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bMc([a-z])/g, (_m, c) => "Mc" + c.toUpperCase());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(v) {
  const s = cleanCell(v);
  if (!s) return { value: "", valid: true, fixed: false };
  const low = s.toLowerCase();
  return { value: low, valid: EMAIL_RE.test(low), fixed: low !== s };
}

export function normalizePhone(v) {
  const s = cleanCell(v);
  if (!s) return { value: "", valid: true, fixed: false };
  // keep a single leading +, strip spaces/dashes/parens/dots
  const cleaned = s.replace(/(?!^\+)[^\d]/g, "").replace(/^(?!\+)/, (m) => m);
  const digits = cleaned.replace(/\D/g, "");
  return { value: cleaned, valid: digits.length >= 7 && digits.length <= 15, fixed: cleaned !== s };
}

// Enum normalize → { value, matched, fixed }
export function normalizeEnum(colKey, raw) {
  const s = cleanCell(raw);
  if (!s) return { value: "", matched: true, fixed: false };
  const col = COLUMN_BY_KEY[colKey];
  const canon = col?.enum || [];
  // already canonical (case-sensitive) ?
  if (canon.includes(s)) return { value: s, matched: true, fixed: false };
  // canonical case-insensitive ?
  const ci = canon.find((c) => c.toLowerCase() === s.toLowerCase());
  if (ci) return { value: ci, matched: true, fixed: ci !== s };
  // synonym ?
  const hit = ENUM_SYNONYMS[colKey]?.[s.toLowerCase()];
  if (hit) return { value: hit, matched: true, fixed: true };
  // nearest canonical as a suggestion
  return { value: s, matched: false, fixed: false, suggestion: nearest(s, canon) };
}

// ── Date parsing (many formats → ISO YYYY-MM-DD) ─────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};
const yr = (y) => (y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y);

// dayFirst: interpret ambiguous DD/MM vs MM/DD as day-first (default true).
export function parseDate(raw, { dayFirst = true } = {}) {
  const c = cleanCell(raw);
  if (c === "") return { value: "", valid: true, fixed: false };
  if (c instanceof Date) return { value: isoOf(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate()), valid: true, fixed: true };

  // Excel serial number
  if (/^\d{2,6}(\.\d+)?$/.test(c) && !/[-/.]/.test(c)) {
    const n = Number(c);
    if (n > 59 && n < 60000) {
      const ms = Math.round((n - 25569) * 86400 * 1000); // 25569 = 1970-01-01 in Excel serial
      const d = new Date(ms);
      const iso = isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      if (iso) return { value: iso, valid: true, fixed: true };
    }
  }
  // ISO YYYY-MM-DD[ T...]
  let m = c.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) { const iso = isoOf(+m[1], +m[2], +m[3]); if (iso) return { value: iso, valid: true, fixed: iso !== c }; }
  // D-Mon-YY / DD Month YYYY
  m = c.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2,4})$/);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) { const iso = isoOf(yr(+m[3]), mo, +m[1]); if (iso) return { value: iso, valid: true, fixed: true }; } }
  // Month D, YYYY
  m = c.match(/^([A-Za-z]{3,9})[ ]+(\d{1,2}),?[ ]+(\d{2,4})$/);
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) { const iso = isoOf(yr(+m[3]), mo, +m[2]); if (iso) return { value: iso, valid: true, fixed: true }; } }
  // DD/MM/YYYY or MM/DD/YYYY (ambiguous)
  m = c.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2], y = yr(+m[3]);
    let dd, mm;
    if (a > 12 && b <= 12) { dd = a; mm = b; }
    else if (b > 12 && a <= 12) { dd = b; mm = a; }
    else { dd = dayFirst ? a : b; mm = dayFirst ? b : a; }
    const iso = isoOf(y, mm, dd);
    if (iso) return { value: iso, valid: true, fixed: true };
  }
  return { value: c, valid: false, fixed: false };
}

// ── Fuzzy nearest (for "did you mean X?") ────────────────────────────────────
function lev(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}
export function nearest(input, candidates) {
  if (!candidates?.length) return null;
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const name = typeof c === "string" ? c : c?.name;
    if (!name) continue;
    const d = lev(input, name);
    if (d < bestD) { bestD = d; best = name; }
  }
  // only suggest if reasonably close (within ~40% of length)
  const thresh = Math.max(2, Math.ceil(Math.max(input.length, (best || "").length) * 0.4));
  return best && bestD <= thresh ? best : null;
}

export function parseFte(raw) {
  const c = cleanCell(raw);
  if (c === "") return { value: 1, fixed: c !== "1" && c !== "" ? true : false, clamped: false };
  let n = Number(String(c).replace("%", ""));
  if (String(c).includes("%")) n = n / 100;
  if (!Number.isFinite(n)) return { value: null, valid: false };
  let clamped = false;
  if (n > 1 && n <= 100) { n = n / 100; clamped = true; } // "80" → 0.8
  if (n < 0) { n = 0; clamped = true; }
  if (n > 1) { n = 1; clamped = true; }
  return { value: Math.round(n * 100) / 100, valid: true, fixed: true, clamped };
}
