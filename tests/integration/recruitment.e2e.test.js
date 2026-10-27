// tests/integration/recruitment.e2e.test.js
//
// Phase 14 residue — WIRE-LEVEL E2E for the Recruitment REST + MCP surfaces.
//
// The unit suites pin every decision; this suite proves the WIRING end to end:
// a real service-JWT passes the real internalServiceGuard, the real F-02
// routeAuthorization wrapper resolves the policy from the URL + method, the
// real tenant-context middleware binds the VERIFIED tenant, and the real
// idempotency middleware protects the mutating POSTs — all through the same
// createApp() factory server.js runs in production (no app-level mocks).
//
// Only the DATABASE seam is mocked (candidateService / applicationService /
// offerService / recruitmentFreeze / offerApproval / handoff / DAM): the E2E
// question is "does a token become the right call with the right identity",
// not "does Postgres store a row" — the .db tests and HR-RLS fleet cover that.
//
// The JWT claims use the gateway's CANONICAL scope form (dotted, space-
// delimited) — pinned in erp-gateway-backend/src/lib/permissionCanonicalize.js
// (CANONICAL_RE + canonicalPermissionScope). A test here that minted the old
// colon-form would silently stop representing production traffic.
//
// Jest ESM note: unstable_mockModule factory objects need STATIC keys for the
// named-import bindings, so the fns are declared explicitly below instead of
// being proxied. A new service export that a controller starts importing gets
// an explicit fn here — a loud, one-line change, never a silent undefined.

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import jwt from "jsonwebtoken";

// ── Identity fixtures ────────────────────────────────────────────

const FIXED_JWT_SECRET = "test-service-secret-do-not-use-in-prod";
const TENANT_A = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
// internalServiceGuard validates tenant claims with uuid.validate (versioned
// UUID required — an all-zero version nibble is rejected), so the second
// tenant must be a version/variant-valid value.
const TENANT_B = "11111111-1111-4222-8333-444455556666";

const RECRUITER_SCOPE = "hr.recruitment.read hr.recruitment.create hr.recruitment.update";
const FREEZE_SCOPE = `${RECRUITER_SCOPE} hr.recruitment.freeze.create hr.recruitment.freeze.read`;
const NO_SCOPE = "";

const ORIGINAL_ENV = { ...process.env };

function mintToken(overrides = {}) {
  return jwt.sign(
    {
      sub: "erp-gateway",
      tenantId: TENANT_A,
      userId: 42,
      employeeId: 42,
      email: "recruiter@example.com",
      roles: ["HR_RECRUITER"],
      scope: RECRUITER_SCOPE,
      ...overrides,
    },
    FIXED_JWT_SECRET,
    { issuer: "erp-gateway", audience: "internal", expiresIn: "5m" },
  );
}

// ── Service-seam mocks (explicit fns; static keys) ───────────────

const candidateFns = {
  createCandidate: jest.fn(async () => ({})),
  updateCandidate: jest.fn(async () => ({})),
  getCandidate: jest.fn(async () => ({})),
  listCandidates: jest.fn(async () => ({ items: [] })),
  updateCandidateResumeMedia: jest.fn(async () => ({})),
};
const applicationFns = {
  getApplication: jest.fn(async () => ({})),
  deleteApplication: jest.fn(async () => ({})),
  createApplication: jest.fn(async () => ({})),
  updateApplicationStage: jest.fn(async () => ({})),
  updateApplicationStatus: jest.fn(async () => ({})),
  listApplications: jest.fn(async () => ({ items: [] })),
};
const offerFns = {
  createOffer: jest.fn(async () => ({})),
  getOffer: jest.fn(async () => ({})),
  listOffers: jest.fn(async () => ({ items: [] })),
  sendOffer: jest.fn(async () => ({})),
  respondOffer: jest.fn(async () => ({})),
  uploadOfferLetter: jest.fn(async () => ({})),
  updateOffer: jest.fn(async () => ({})),
};
const freezeFns = {
  activeFreezeFor: jest.fn(async () => null),
  assertNotHiringFrozen: jest.fn(async () => undefined),
  setHiringFreeze: jest.fn(async () => ({})),
  liftHiringFreeze: jest.fn(async () => ({})),
  listHiringFreezes: jest.fn(async () => ({ items: [] })),
};
const approvalFns = {
  approveOffer: jest.fn(async () => ({})),
  assertOfferApproved: jest.fn(async () => undefined),
  getOfferApprovalPolicy: jest.fn(async () => ({ rules: [] })),
  setOfferApprovalPolicy: jest.fn(async () => ({ rules: [] })),
};
const handoffFns = {
  listFailedHandoffs: jest.fn(async () => ({})),
  getOfferHandoff: jest.fn(async () => ({})),
  runOfferHandoff: jest.fn(async () => ({})),
};
const damFns = {
  damRequest: jest.fn(async () => ({})),
  normalizeDamAssetResponse: jest.fn((p) => p),
  deleteDamAsset: jest.fn(async () => ({})),
  getDamAssetById: jest.fn(async () => ({})),
  downloadDamAssetBuffer: jest.fn(async () => Buffer.alloc(0)),
  uploadFileToDAM: jest.fn(async () => ({ id: 1, url: "asset://test" })),
};

jest.unstable_mockModule("../../src/services/candidate.service.js", () => candidateFns);
jest.unstable_mockModule("../../src/services/application.service.js", () => applicationFns);
jest.unstable_mockModule("../../src/services/offer.service.js", () => offerFns);
jest.unstable_mockModule("../../src/services/recruitment-freeze.service.js", () => ({
  ...freezeFns,
  FREEZE_SCOPES: Object.freeze(["COMPANY", "BUSINESS_UNIT"]),
}));
jest.unstable_mockModule("../../src/services/offer-approval.service.js", () => ({
  ...approvalFns,
  OFFER_APPROVAL_STAGES: Object.freeze(["hiringManager", "hrHead", "finance"]),
}));
jest.unstable_mockModule("../../src/services/recruitment-handoff.service.js", () => ({
  ...handoffFns,
  HANDOFF_STATUS: Object.freeze({ PENDING: "pending", COMPLETED: "completed", FAILED: "failed" }),
}));
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => damFns);

installSeamDefaults();

// ── App under test (the REAL production middleware chain) ────────

let app;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.SERVICE_JWT_SECRET = FIXED_JWT_SECRET;
  process.env.SERVICE_JWT_AUDIENCE = "internal";
  process.env.SERVICE_JWT_ISSUER = "erp-gateway";
  // Force the DETERMINISTIC memory idempotency store. src/lib/prisma.js runs
  // dotenv.config() at import (re-reading .env, which carries REDIS_URL), and
  // dotenv never overwrites keys already present in process.env — so pre-set
  // empty strings WIN over .env. A Redis store here would race its own connect
  // on the first reserve and fail open (non-deterministic replays).
  process.env.HR_REDIS_URL = "";
  process.env.REDIS_URL = "";

  const { default: createApp } = await import("../../src/app.js");
  app = createApp();
}, 60000);

afterAll(() => {
  for (const key of ["SERVICE_JWT_SECRET", "SERVICE_JWT_AUDIENCE", "SERVICE_JWT_ISSUER"]) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

// supertest v7: the fluent chain starts with the VERB — request(app).get(url)
// — and .set()/.send() hang off the returned Test. Helpers below keep the verb
// first so the header lands on the request, not on a bare factory object.
const AUTH_HEADER = (token) => ["x-service-authorization", `Bearer ${token}`];
const authed = (token) => ({
  get: (url) => request(app).get(url).set(...AUTH_HEADER(token)),
  post: (url) => request(app).post(url).set(...AUTH_HEADER(token)),
  put: (url) => request(app).put(url).set(...AUTH_HEADER(token)),
  delete: (url) => request(app).delete(url).set(...AUTH_HEADER(token)),
});
const recruiter = () => authed(mintToken());

// Re-install the deterministic seam behaviour. Runs in every describe's
// beforeEach so a mockImplementationOnce consumed (or not consumed) by an
// earlier test can never leak into a later one.
function installSeamDefaults() {
  candidateFns.createCandidate.mockImplementation(async (args) => ({
    id: 101, firstName: args.firstName, email: args.email, tenantId: args.tenantId, createdById: args.createdById,
  }));
  candidateFns.listCandidates.mockImplementation(async (args) => ({
    items: [{ id: 101, email: "found@example.com" }], tenantId: args.tenantId,
  }));
  candidateFns.updateCandidate.mockImplementation(async (args) => ({
    id: args.id, status: args.data?.status ?? null, tenantId: args.tenantId,
  }));
  applicationFns.createApplication.mockImplementation(async (args) => ({
    id: 9001, candidateId: args.candidateId, jobRequisitionId: args.jobRequisitionId, tenantId: args.tenantId,
  }));
  offerFns.createOffer.mockImplementation(async (args) => ({
    id: 7001, applicationId: args.applicationId, tenantId: args.tenantId, createdById: args.createdById,
  }));
  freezeFns.setHiringFreeze.mockImplementation(async (tenantId, { scope, reason, createdById }) => ({
    id: 55, scope, reason: reason ?? null, createdById: createdById ?? null, tenantId,
  }));
  freezeFns.listHiringFreezes.mockImplementation(async (tenantId) => ({ items: [], tenantId }));
  freezeFns.liftHiringFreeze.mockImplementation(async (tenantId, freezeId, { reason, liftedById }) => ({
    id: freezeId, reason: reason ?? null, liftedById: liftedById ?? null, tenantId,
  }));
}

// ── A. The /api internal boundary (real JWT, real guard) ─────────

describe("recruitment E2E — /api boundary", () => {
  it("rejects an anonymous caller before any route logic runs", async () => {
    const res = await request(app).post("/api/recruitment/candidates").send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Direct service access is not allowed");
  });

  it("rejects a tenantless service JWT with HR-0601 (F-06)", async () => {
    const res = await authed(mintToken({ tenantId: undefined }))
      .post("/api/recruitment/candidates")
      .send({ firstName: "Ayesha", email: "ayesha@example.com" });
    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe("HR-0601");
  });

  it("rejects a token signed with the wrong secret (401, not a fallthrough)", async () => {
    const forged = jwt.sign(
      { sub: "erp-gateway", tenantId: TENANT_A, userId: 42, scope: RECRUITER_SCOPE },
      "attacker-secret",
      { issuer: "erp-gateway", audience: "internal", expiresIn: "5m" },
    );
    const res = await authed(forged).get("/api/recruitment/candidates");
    expect(res.status).toBe(401);
  });

  it("denies an undeclared route with HR-0201", async () => {
    const res = await recruiter().get("/api/recruitment/definitely-not-a-route");
    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe("HR-0201");
  });
});

// ── B. Candidate surface over the wire ───────────────────────────

describe("recruitment E2E — candidates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installSeamDefaults();
  });

  it("valid recruiter token → 201 with the verified identity on the service call", async () => {
    const res = await recruiter()
      .post("/api/recruitment/candidates")
      .send({ firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(101);
    expect(candidateFns.createCandidate).toHaveBeenCalledTimes(1);
    const args = candidateFns.createCandidate.mock.calls[0][0];
    expect(args.tenantId).toBe(TENANT_A); // from the VERIFIED claim
    expect(args.createdById).toBe(42);
  });

  it("a spoofed x-tenant-id header NEVER reaches the service (X-02 at the wire)", async () => {
    const res = await request(app)
      .post("/api/recruitment/candidates")
      .set(...AUTH_HEADER(mintToken()))
      .set("x-tenant-id", TENANT_B)
      .send({ firstName: "Ayesha", email: "ayesha@example.com" });

    expect(res.status).toBe(201);
    expect(candidateFns.createCandidate.mock.calls[0][0].tenantId).toBe(TENANT_A);
  });

  it("a token without the recruitment scope is denied at the route (HR-0204), service untouched", async () => {
    const res = await authed(mintToken({ scope: NO_SCOPE }))
      .post("/api/recruitment/candidates")
      .send({ firstName: "Ayesha", email: "ayesha@example.com" });

    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe("HR-0204");
    expect(candidateFns.createCandidate).not.toHaveBeenCalled();
  });

  it("a token scoped for a DIFFERENT module cannot create candidates", async () => {
    const res = await authed(mintToken({ scope: "hr.payroll.read hr.payroll.create" }))
      .post("/api/recruitment/candidates")
      .send({ firstName: "Ayesha", email: "ayesha@example.com" });
    expect(res.status).toBe(403);
    expect(candidateFns.createCandidate).not.toHaveBeenCalled();
  });

  it("a stale expectedVersion surfaces as 412 HR-4120 with the current version", async () => {
    candidateFns.updateCandidate.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Stale write"), {
        status: 412, code: "HR-4120", currentVersion: 7,
      });
    });

    const res = await recruiter()
      .put("/api/recruitment/candidates/5")
      .send({ status: "archived", expectedVersion: 3 });

    expect(res.status).toBe(412);
    expect(res.body.code).toBe("HR-4120");
    expect(res.body.currentVersion).toBe(7);
  });

  it("listing carries the verified tenant into the record-scope call", async () => {
    const res = await recruiter().get("/api/recruitment/candidates?page=1&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].id).toBe(101);
    expect(candidateFns.listCandidates.mock.calls[0][0].tenantId).toBe(TENANT_A);
  });
});

// ── C. Idempotency at the wire (the Phase 14 wiring guarantee) ───

describe("recruitment E2E — idempotent candidate create", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installSeamDefaults();
  });

  it("replays the cached 201 for a repeated Idempotency-Key; the service runs ONCE", async () => {
    const send = () => recruiter()
      .post("/api/recruitment/candidates")
      .set("Idempotency-Key", "e2e-candidate-1")
      .send({ firstName: "Ayesha", email: "ayesha@example.com" });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(candidateFns.createCandidate).toHaveBeenCalledTimes(1);
  });

  it("different keys are different submissions", async () => {
    await recruiter().post("/api/recruitment/candidates").set("Idempotency-Key", "e2e-key-a")
      .send({ firstName: "A", email: "a@example.com" });
    await recruiter().post("/api/recruitment/candidates").set("Idempotency-Key", "e2e-key-b")
      .send({ firstName: "B", email: "b@example.com" });

    expect(candidateFns.createCandidate).toHaveBeenCalledTimes(2);
  });

  it("a FAILED create is not cached — the retry re-runs the service", async () => {
    candidateFns.createCandidate
      .mockImplementationOnce(async () => { throw new Error("transient downstream"); })
      .mockImplementationOnce(async (args) => ({ id: 102, email: args.email }));

    const first = await recruiter().post("/api/recruitment/candidates").set("Idempotency-Key", "e2e-retry-1")
      .send({ firstName: "R", email: "r@example.com" });
    const second = await recruiter().post("/api/recruitment/candidates").set("Idempotency-Key", "e2e-retry-1")
      .send({ firstName: "R", email: "r@example.com" });

    expect(first.status).toBe(400);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(102);
    expect(candidateFns.createCandidate).toHaveBeenCalledTimes(2);
  });

  it("idempotency keys do not cross tenants (verified-tenant namespacing)", async () => {
    const tenantBToken = jwt.sign(
      {
        sub: "erp-gateway", tenantId: TENANT_B, userId: 7, employeeId: 7,
        roles: ["HR_RECRUITER"], scope: RECRUITER_SCOPE,
      },
      FIXED_JWT_SECRET,
      { issuer: "erp-gateway", audience: "internal", expiresIn: "5m" },
    );

    await authed(mintToken()).post("/api/recruitment/candidates").set("Idempotency-Key", "e2e-shared-key")
      .send({ firstName: "A", email: "a@example.com" });
    const resB = await authed(tenantBToken).post("/api/recruitment/candidates").set("Idempotency-Key", "e2e-shared-key")
      .send({ firstName: "B", email: "b@example.com" });

    // Same key, DIFFERENT verified tenant → a real second submission.
    expect(resB.status).toBe(201);
    expect(candidateFns.createCandidate).toHaveBeenCalledTimes(2);
    expect(candidateFns.createCandidate.mock.calls[1][0].tenantId).toBe(TENANT_B);
  });
});

// ── D. Applications + offers over the wire ───────────────────────

describe("recruitment E2E — applications and offers", () => {
  beforeEach(() => { jest.clearAllMocks(); installSeamDefaults(); });

  it("application create passes the verified tenant and actor through", async () => {
    const res = await recruiter()
      .post("/api/recruitment/applications")
      .send({ candidateId: 101, jobRequisitionId: 3 });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(9001);
    const args = applicationFns.createApplication.mock.calls[0][0];
    expect(args.tenantId).toBe(TENANT_A);
    expect(args.createdById).toBe(42);
  });

  it("offer create is idempotent at the wire (POST /api/offers + Idempotency-Key)", async () => {
    const send = () => recruiter()
      .post("/api/offers")
      .set("Idempotency-Key", "e2e-offer-1")
      .send({ applicationId: 9001, candidateId: 101, jobRequisitionId: 3, salary: 250000, currency: "PKR" });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(offerFns.createOffer).toHaveBeenCalledTimes(1);
  });
});

// ── E. Hiring-freeze privilege separation (§2.7) at the wire ─────

describe("recruitment E2E — hiring freeze is a distinct resource", () => {
  beforeEach(() => { jest.clearAllMocks(); installSeamDefaults(); });

  it("a recruiter with full recruitment grants CANNOT set a freeze (HR-0204)", async () => {
    const res = await recruiter()
      .post("/api/recruitment/freeze")
      .send({ scope: "COMPANY", reason: "budget pause" });

    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe("HR-0204");
    expect(res.body.errors[0].message).toContain("hr.recruitment.freeze.create");
    expect(freezeFns.setHiringFreeze).not.toHaveBeenCalled();
  });

  it("the freeze-granted principal sets a freeze with the verified actor", async () => {
    const res = await authed(mintToken({ scope: FREEZE_SCOPE }))
      .post("/api/recruitment/freeze")
      .send({ scope: "COMPANY", reason: "budget pause" });

    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe("COMPANY");
    const args = freezeFns.setHiringFreeze.mock.calls[0];
    expect(args[0]).toBe(TENANT_A);
    expect(args[1].createdById).toBe(42);
  });

  it("freeze listing requires the dedicated freeze resource (read), not just recruitment.read", async () => {
    // GET maps to the `read` action on the freeze resource — a plain
    // hr.recruitment.read grant does NOT satisfy it.
    const res = await authed(mintToken({ scope: FREEZE_SCOPE })).get("/api/recruitment/freeze");
    expect(res.status).toBe(200);
    expect(freezeFns.listHiringFreezes.mock.calls[0][0]).toBe(TENANT_A);
  });
});

// ── F. MCP wire parity through the REAL /mcp mount ───────────────

const reqIdCounter = { n: 0 };

async function rpc(claims, method, params = {}, extraHeaders = {}) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2024-11-05",
        "x-mcp-internal": "true",
        "x-service-authorization": `Bearer ${mintToken(claims)}`,
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++reqIdCounter.n }),
    });
    const text = await res.text();
    // SSE may carry several data: frames (pings, split messages). Parse EVERY
    // data: line and take the first frame that carries a JSON-RPC result or
    // error — a single greedy regex match can span frames and fail to parse.
    let body = null;
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed && (parsed.result || parsed.error)) { body = parsed; break; }
      } catch { /* try next frame */ }
    }
    if (!body) { try { body = JSON.parse(text); } catch { /* leave null */ } }
    return { status: res.status, body, raw: text };
  } finally {
    server.close();
  }
}

const FULL_CLAIMS = {
  tenantId: TENANT_A, userId: 42, employeeId: 42,
  roles: ["HR_RECRUITER"], scope: RECRUITER_SCOPE,
};
const EMPTY_CLAIMS = { tenantId: TENANT_A, userId: 43, employeeId: 43, roles: [], scope: "" };

const INIT = ["initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "recruitment-e2e", version: "1.0.0" } }];

describe("recruitment E2E — MCP surface through the real guard", () => {
  beforeEach(() => { jest.clearAllMocks(); installSeamDefaults(); });

  it("initialize completes through the real JWT guard", async () => {
    const { body } = await rpc(FULL_CLAIMS, ...INIT);
    expect(body?.result?.serverInfo).toBeDefined();
  });

  it("tools/list exposes the Recruitment inventory (representative names present)", async () => {
    await rpc(FULL_CLAIMS, ...INIT);
    const { body } = await rpc(FULL_CLAIMS, "tools/list");
    const names = (body?.result?.tools || []).map((t) => t.name);

    for (const name of [
      "hr_candidate_create",
      "hr_candidate_update",
      "hr_application_create",
      "hr_application_screening_record",
      "hr_candidate_match",
      "hr_candidate_retention_apply",
      "hr_candidate_anonymize",
      "hr_requisition_approve",
      "hr_requisitions_export",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("tools/call hr_candidate_create flows into the SAME service seam with verified identity", async () => {
    await rpc(FULL_CLAIMS, ...INIT);
    const { body } = await rpc(FULL_CLAIMS, "tools/call", {
      name: "hr_candidate_create",
      arguments: { firstName: "Ayesha", email: "ayesha@example.com" },
    });

    expect(body?.result?.isError).toBeUndefined();
    // The tool serialises runController's payload — the controller envelope —
    // so the created row lives under `data`.
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.data.id).toBe(101);

    expect(candidateFns.createCandidate).toHaveBeenCalledTimes(1);
    const args = candidateFns.createCandidate.mock.calls[0][0];
    expect(args.tenantId).toBe(TENANT_A);
    expect(args.createdById).toBe(42);
  });

  it("MCP ignores a spoofed x-tenant-id exactly like REST does", async () => {
    await rpc(FULL_CLAIMS, ...INIT);
    await rpc(FULL_CLAIMS, "tools/call", {
      name: "hr_candidate_create",
      arguments: { firstName: "S", email: "s@example.com" },
    }, { "x-tenant-id": TENANT_B });

    expect(candidateFns.createCandidate.mock.calls[0][0].tenantId).toBe(TENANT_A);
  });

  it("a zero-scope caller gets isError with the 403 gate, not data", async () => {
    await rpc(EMPTY_CLAIMS, ...INIT);
    const { body } = await rpc(EMPTY_CLAIMS, "tools/call", {
      name: "hr_candidate_create",
      arguments: { firstName: "X", email: "x@example.com" },
    });

    expect(body?.result?.isError).toBe(true);
    const errText = body.result.content?.[0]?.text || "";
    expect(errText).toMatch(/403|Insufficient permissions/);
    expect(candidateFns.createCandidate).not.toHaveBeenCalled();
  });
});
