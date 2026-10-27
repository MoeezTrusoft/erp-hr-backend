// D-12: If-Match reaches finalize from both REST and MCP, and a stale version
// keeps its 412 instead of being flattened to a 400.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PreconditionFailedError } from "../../src/lib/optimisticConcurrency.js";

const finalizePayrollRun = jest.fn(async (id) => ({ id, status: "FINALIZED" }));
jest.unstable_mockModule("../../src/services/payrollService.js", () => ({ finalizePayrollRun }));
jest.unstable_mockModule("../../src/services/bankFileService.js", () => ({}));
jest.unstable_mockModule("../../src/lib/c4Access.js", () => ({ auditC4Read: jest.fn() }));

const payroll = await import("../../src/controllers/payrollController.js");
const { runController } = await import("../../src/mcp/controllers/_runner.js");

const response = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
};
const request = (headers = {}) => ({
  params: { id: "12" },
  headers,
  user: { employeeId: 7, tenantId: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007" },
});

beforeEach(() => jest.clearAllMocks());

describe("D-12 finalize If-Match wiring", () => {
  it("passes the REST If-Match header to the service", async () => {
    const res = response();
    await payroll.finalizePayrollRun(request({ "if-match": '"1792416772228"' }), res);
    expect(finalizePayrollRun).toHaveBeenCalledWith(12, 7, expect.anything(), { ifMatch: '"1792416772228"' });
    expect(res.statusCode).toBe(200);
  });

  it("answers a stale version with 412, not 400", async () => {
    finalizePayrollRun.mockRejectedValueOnce(new PreconditionFailedError());
    const res = response();
    await payroll.finalizePayrollRun(request({ "if-match": '"1"' }), res);
    expect(res.statusCode).toBe(412);
  });

  it("carries the MCP ifMatch argument through the controller runner", async () => {
    await runController(payroll.finalizePayrollRun, {
      user: { employeeId: 7, tenantId: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007" },
      params: { id: "12" },
      headers: { "if-match": "1792416772228" },
    });
    expect(finalizePayrollRun).toHaveBeenCalledWith(12, 7, expect.anything(), { ifMatch: "1792416772228" });
  });
});
