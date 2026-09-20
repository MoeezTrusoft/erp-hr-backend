// tests/unit/recruitment.actorIdentity.test.js
//
// T-P2.1 / F-07 — every Recruitment actor is taken from the VERIFIED service-JWT
// claim (req.user), never from a caller-controlled header or body field.
//
// These controller paths feed the Phase 3 state machine, so a forged actor is not
// cosmetic: it decides whose name lands on a requisition approval record, and the
// MCP path (which sends no headers at all) previously recorded NO actor for
// approve / post / delete.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const createRequisition = jest.fn(async () => ({ id: 1 }));
const deleteRequisitions = jest.fn(async () => ({ count: 1 }));
const approveRequisition = jest.fn(async () => ({ id: 1 }));
const postRequisition = jest.fn(async () => ({ id: 1 }));
const updateRequisition = jest.fn(async () => ({ id: 1 }));
jest.unstable_mockModule("../../src/services/requisition.service.js", () => ({
  createRequisition,
  deleteRequisitions,
  approveRequisition,
  postRequisition,
  updateRequisition,
  getAllRequisitions: jest.fn(async () => []),
  getByIdRequisitions: jest.fn(async () => null),
}));

const addToPool = jest.fn(async () => ({ id: 1 }));
jest.unstable_mockModule("../../src/services/talentPool.service.js", () => ({
  addToPool,
  listPools: jest.fn(async () => []),
  removeFromPool: jest.fn(async () => ({})),
  getCandidatesInPool: jest.fn(async () => []),
}));

const req = await import("../../src/controllers/requisition.controller.js");
const pool = await import("../../src/controllers/talentPool.controller.js");

const TENANT = "11111111-1111-4111-8111-111111111111";

// A caller who is employee 77 but ships headers claiming to be employee 999 and a
// different tenant. The claim must win on both counts.
const REQUEST = (user = { employeeId: 77, userId: 500, tenantId: TENANT }) => ({
  user,
  params: { id: "42" },
  body: {},
  headers: {
    "employee-id": "999",
    "x-employee-id": "999",
    "x-tenant-id": "22222222-2222-4222-8222-222222222222",
  },
});

const response = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
};

describe("Recruitment actor identity comes from the verified claim", () => {
  beforeEach(() => jest.clearAllMocks());

  it("create uses the verified employee, not the forged header", async () => {
    await req.createRequisitionController(REQUEST(), response());

    expect(createRequisition).toHaveBeenCalledWith({}, 77, TENANT);
  });

  it("approve attributes the decision to the verified approver", async () => {
    await req.approveRequisitionController(REQUEST(), response());

    expect(approveRequisition).toHaveBeenCalledWith("42", undefined, undefined, 77, TENANT);
  });

  it("post, update and delete all attribute to the verified actor", async () => {
    await req.postRequisitionController(REQUEST(), response());
    await req.updateRequisitionController(REQUEST(), response());
    await req.deletRequisitionsController(REQUEST(), response());

    expect(postRequisition).toHaveBeenCalledWith("42", undefined, 77, TENANT);
    expect(updateRequisition).toHaveBeenCalledWith("42", {}, 77, TENANT);
    expect(deleteRequisitions).toHaveBeenCalledWith("42", 77, TENANT);
  });

  it("talent-pool attribution ignores the forged header too", async () => {
    await pool.addToPool({ ...REQUEST(), body: { poolId: 3, candidateId: 9 } }, response());

    expect(addToPool).toHaveBeenCalledWith(
      expect.objectContaining({ addedById: 77, tenantId: TENANT }),
    );
  });

  it("an explicit requestedById is a business field, not the caller identity", async () => {
    await req.createRequisitionController(
      { ...REQUEST(), body: { requestedById: 123 } },
      response(),
    );

    expect(createRequisition).toHaveBeenCalledWith({ requestedById: 123 }, 123, TENANT);
  });

  it("a caller cannot smuggle an actor through the body when no claim employee exists", async () => {
    // RBAC-only admin: the resolver yields null rather than trusting body/headers.
    const admin = { isAdmin: true, userId: 500, tenantId: TENANT };

    await req.updateRequisitionController(REQUEST(admin), response());

    expect(updateRequisition).toHaveBeenCalledWith("42", {}, null, TENANT);
  });

  it("a body employeeId no longer overrides a missing verified actor", async () => {
    await req.createRequisitionController(
      { ...REQUEST({ isAdmin: true, tenantId: TENANT }), body: { employeeId: 999 } },
      response(),
    );

    expect(createRequisition).toHaveBeenCalledWith({ employeeId: 999 }, null, TENANT);
  });
});
