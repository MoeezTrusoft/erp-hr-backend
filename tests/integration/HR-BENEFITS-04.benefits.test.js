// HR-BENEFITS-04 — Benefits module: plan CRUD, employee enroll/unenroll, list,
// tenant-scoping (cross-tenant 404) and deny-by-default permission gating.
//
// Runner: jest (ESM, --experimental-vm-modules). Prisma is replaced with a tiny
// in-memory fake so the test exercises real routing + permission + tenant logic
// end-to-end without a live database.
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// ── in-memory prisma fake ─────────────────────────────────────────────────────
const makeTable = () => {
  const rows = [];
  let seq = 0;
  const match = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => (v === undefined ? true : row[k] === v));
  return {
    rows,
    create: async ({ data }) => {
      const r = { id: ++seq, ...data };
      rows.push(r);
      return { ...r };
    },
    findMany: async ({ where = {} } = {}) => rows.filter((r) => match(r, where)).map((r) => ({ ...r })),
    findFirst: async ({ where = {} } = {}) => {
      const r = rows.find((x) => match(x, where));
      return r ? { ...r } : null;
    },
    findUnique: async ({ where = {} } = {}) => {
      const r = rows.find((x) => match(x, where));
      return r ? { ...r } : null;
    },
    update: async ({ where, data }) => {
      const r = rows.find((x) => x.id === where.id);
      Object.assign(r, data);
      return { ...r };
    },
    delete: async ({ where }) => {
      const i = rows.findIndex((x) => x.id === where.id);
      const [r] = rows.splice(i, 1);
      return { ...r };
    },
    count: async ({ where = {} } = {}) => rows.filter((r) => match(r, where)).length,
  };
};

const benefitPlan = makeTable();
const employeeBenefit = makeTable();
const employee = makeTable();

// findMany on employeeBenefit resolves the benefitPlan include like Prisma.
const ebFindMany = employeeBenefit.findMany;
employeeBenefit.findMany = async ({ where = {}, include } = {}) => {
  const list = await ebFindMany({ where });
  if (include?.benefitPlan) {
    return list.map((e) => ({
      ...e,
      benefitPlan: benefitPlan.rows.find((p) => p.id === e.benefitPlanId) ?? null,
    }));
  }
  return list;
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: { benefitPlan, employeeBenefit, employee },
}));

// Import AFTER the mock is registered.
const benefitsRoutes = (await import('../../src/routes/benefit.routes.js')).default;

// ── test app: simulate internalServiceGuard + attachHrContext via headers ─────
const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const parse = (v, f) => {
      try {
        return v ? JSON.parse(v) : f;
      } catch {
        return f;
      }
    };
    req.user = {
      role: req.headers['x-role'] || 'ADMIN',
      permissions: parse(req.headers['x-perms'], {}),
      tenantId: req.headers['x-tenant'] || null,
    };
    next();
  });
  app.use('/api/benefits', benefitsRoutes);
  return app;
};

const app = buildApp();
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const FULL = JSON.stringify({ 'hr:benefits': ['VIEW', 'CREATE', 'EDIT', 'DELETE'] });

const asA = (r) => r.set('x-perms', FULL).set('x-tenant', TENANT_A);
const asB = (r) => r.set('x-perms', FULL).set('x-tenant', TENANT_B);

describe('HR-BENEFITS-04 — benefit plans + enrollment', () => {
  describe('deny-by-default permission gating', () => {
    it('rejects plan create with NO permissions (403)', async () => {
      const res = await request(app)
        .post('/api/benefits/plans')
        .set('x-tenant', TENANT_A)
        .send({ name: 'Gold Health', type: 'HEALTH' });
      expect(res.status).toBe(403);
    });

    it('rejects plan list with NO permissions (403)', async () => {
      const res = await request(app).get('/api/benefits/plans').set('x-tenant', TENANT_A);
      expect(res.status).toBe(403);
    });
  });

  describe('plan CRUD (gated + tenant-scoped)', () => {
    let planId;

    it('creates a plan with money fields (201)', async () => {
      const res = await asA(request(app).post('/api/benefits/plans')).send({
        name: 'Gold Health',
        type: 'HEALTH',
        description: 'PPO',
        employerContribution: 500.5,
        employeeContribution: 120.25,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      // money round-trips through minor units → major.
      expect(res.body.data.employerContribution).toBe(500.5);
      expect(res.body.data.employeeContribution).toBe(120.25);
      expect(res.body.data.active).toBe(true);
      planId = res.body.data.id;
    });

    it('rejects an invalid benefit type (400)', async () => {
      const res = await asA(request(app).post('/api/benefits/plans')).send({
        name: 'Bad',
        type: 'NOPE',
      });
      expect(res.status).toBe(400);
    });

    it('lists only the caller-tenant plans', async () => {
      await asB(request(app).post('/api/benefits/plans')).send({ name: 'B Retire', type: 'RETIREMENT' });
      const resA = await asA(request(app).get('/api/benefits/plans'));
      expect(resA.status).toBe(200);
      expect(resA.body.data.every((p) => p.name !== 'B Retire')).toBe(true);
      expect(resA.body.data.some((p) => p.id === planId)).toBe(true);
    });

    it('gets a plan in-tenant (200)', async () => {
      const res = await asA(request(app).get(`/api/benefits/plans/${planId}`));
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Gold Health');
    });

    it('returns 404 for a plan owned by another tenant (cross-tenant)', async () => {
      const res = await asB(request(app).get(`/api/benefits/plans/${planId}`));
      expect(res.status).toBe(404);
    });

    it('updates a plan in-tenant (200)', async () => {
      const res = await asA(request(app).put(`/api/benefits/plans/${planId}`)).send({ active: false });
      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });

    it('refuses to update a cross-tenant plan (404)', async () => {
      const res = await asB(request(app).put(`/api/benefits/plans/${planId}`)).send({ active: true });
      expect(res.status).toBe(404);
    });

    it('refuses to delete a cross-tenant plan (404)', async () => {
      const res = await asB(request(app).delete(`/api/benefits/plans/${planId}`));
      expect(res.status).toBe(404);
    });
  });

  describe('enroll / list / unenroll', () => {
    let planId;
    const EMP = 77;

    beforeAll(async () => {
      const res = await asA(request(app).post('/api/benefits/plans')).send({
        name: '401k',
        type: 'RETIREMENT',
      });
      planId = res.body.data.id;
    });

    it('enrolls an employee (201)', async () => {
      const res = await asA(request(app).post(`/api/benefits/employees/${EMP}/enroll`)).send({
        benefitPlanId: planId,
        electedAmount: 200.75,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.electedAmount).toBe(200.75);
    });

    it('refuses enrollment without permission (403)', async () => {
      const res = await request(app)
        .post(`/api/benefits/employees/${EMP}/enroll`)
        .set('x-tenant', TENANT_A)
        .send({ benefitPlanId: planId });
      expect(res.status).toBe(403);
    });

    it('refuses enrollment against a cross-tenant plan (404)', async () => {
      const res = await asB(request(app).post(`/api/benefits/employees/${EMP}/enroll`)).send({
        benefitPlanId: planId,
      });
      expect(res.status).toBe(404);
    });

    it("lists the employee's active benefits with plan detail", async () => {
      const res = await asA(request(app).get(`/api/benefits/employees/${EMP}/benefits`));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].benefitPlan.name).toBe('401k');
    });

    it('returns no benefits for the same employee under another tenant', async () => {
      const res = await asB(request(app).get(`/api/benefits/employees/${EMP}/benefits`));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(0);
    });

    it('unenrolls the employee (200) and drops them from the active list', async () => {
      const res = await asA(
        request(app).delete(`/api/benefits/employees/${EMP}/benefits/${planId}`),
      );
      expect(res.status).toBe(200);
      const list = await asA(request(app).get(`/api/benefits/employees/${EMP}/benefits`));
      expect(list.body.data.length).toBe(0);
    });
  });
});
