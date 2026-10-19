// tests/mocks/fakePrisma.js — minimal in-memory Prisma double for service and
// tool tests that need real create/find/update semantics without Postgres.
// Supports the subset the engagement module uses: equality, in/not/lt/gt,
// array_contains (JSON arrays), contains+mode, OR/AND, compound unique keys
// (`tenantId_partyId: {...}`), `{ increment }` updates, orderBy (first key),
// take, count, updateMany, deleteMany, upsert, and interactive $transaction.
import { randomUUID } from 'node:crypto';

const DEFAULTS = {
  engagementParty: { kind: 'PERSON', role: 'LEAD', stage: 'NEW', emails: [], phones: [], identities: [], tags: [], version: 1, mergedIntoId: null },
  engagementEvent: { direction: 'INBOUND', sourceSystem: 'MANUAL', participants: [], attachments: [], metadata: {}, extractedAt: null },
  engagementProfile: { version: 0, summary: '', structured: {}, refreshStatus: 'IDLE', eventsAtRefresh: 0, lastEventAt: null, lastRefreshedAt: null, lastError: null, model: null },
  engagementFact: { confidence: 0.5, status: 'ACTIVE', sourceEventId: null, supersededById: null },
  engagementDocument: { status: 'DRAFT', format: 'MARKDOWN', structured: {}, profileVersion: 0, sourceEventIds: [], version: 1, approvedAt: null, sentAt: null, deliveryRef: null },
  engagementProjectLink: { status: 'PROPOSED', proposal: {}, brief: {}, version: 1, pmProjectId: null, lastSyncedAt: null, lastError: null },
  engagementLlmRun: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0, status: 'SUCCEEDED' },
  engagementInboxEvent: { status: 'PENDING', attempts: 0, processedAt: null, lastErrorCode: null },
  engagementCommandReceipt: {},
  outboxEvent: { publishedAt: null, attempts: 0 },
};

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

const matchValue = (actual, cond) => {
  if (!isPlain(cond)) return deepEq(actual, cond);
  return Object.entries(cond).every(([op, v]) => {
    switch (op) {
      case 'equals': return deepEq(actual, v);
      case 'in': return v.includes(actual);
      case 'not': return isPlain(v) ? !matchValue(actual, v) : !deepEq(actual, v);
      case 'lt': return actual < v;
      case 'lte': return actual <= v;
      case 'gt': return actual > v;
      case 'gte': return actual >= v;
      case 'contains': return String(actual ?? '').toLowerCase().includes(String(v).toLowerCase());
      case 'mode': return true;
      case 'array_contains': return Array.isArray(actual) && v.every((needle) => actual.some((item) => deepEq(item, needle)));
      default: return deepEq(actual, cond);
    }
  });
};

const deepEq = (a, b) => {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return JSON.stringify(a) === JSON.stringify(b);
};

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((w) => matches(row, w));
    if (key === 'AND') return cond.every((w) => matches(row, w));
    if (key === 'NOT') return !matches(row, cond);
    if (key.includes('_') && isPlain(cond) && !(key in row)) return matches(row, cond); // compound unique
    return matchValue(row[key], cond);
  });

const applyData = (row, data) => {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (isPlain(value) && 'increment' in value) next[key] = (row[key] ?? 0) + value.increment;
    else next[key] = value;
  }
  next.updatedAt = new Date();
  return next;
};

const sortRows = (rows, orderBy) => {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0];
      const av = a[key]; const bv = b[key];
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
};

export function createFakePrisma() {
  const tables = Object.fromEntries(Object.keys(DEFAULTS).map((m) => [m, []]));
  const model = (name) => ({
    create: async ({ data }) => {
      const now = new Date();
      const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...DEFAULTS[name], ...data };
      tables[name].push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take } = {}) => {
      const rows = sortRows(tables[name].filter((r) => matches(r, where)), orderBy);
      return take != null ? rows.slice(0, take) : rows;
    },
    findFirst: async ({ where, orderBy } = {}) => sortRows(tables[name].filter((r) => matches(r, where)), orderBy)[0] ?? null,
    findUnique: async ({ where }) => tables[name].find((r) => matches(r, where)) ?? null,
    count: async ({ where } = {}) => tables[name].filter((r) => matches(r, where)).length,
    update: async ({ where, data }) => {
      const idx = tables[name].findIndex((r) => matches(r, where));
      if (idx < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      tables[name][idx] = applyData(tables[name][idx], data);
      return tables[name][idx];
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      tables[name] = tables[name].map((r) => (matches(r, where) ? (count++, applyData(r, data)) : r));
      return { count };
    },
    deleteMany: async ({ where } = {}) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !matches(r, where));
      return { count: before - tables[name].length };
    },
    upsert: async ({ where, create, update }) => {
      const idx = tables[name].findIndex((r) => matches(r, where));
      if (idx >= 0) { tables[name][idx] = applyData(tables[name][idx], update); return tables[name][idx]; }
      return model(name).create({ data: create });
    },
  });
  const client = { __tables: tables, $executeRaw: async () => 1, $queryRaw: async () => [] };
  for (const name of Object.keys(DEFAULTS)) client[name] = model(name);
  client.$transaction = async (fn) => fn(client);
  return client;
}
