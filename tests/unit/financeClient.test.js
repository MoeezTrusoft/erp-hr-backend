// tests/unit/financeClient.test.js
//
// The contract client itself (decision B1.1/B1.2) — separate from
// financeValidity.test.js because that file mocks the client module, and a
// module-level mock would shadow the real implementation here.
//
//   * no FINANCE_SERVICE_URL → off mode, no outbound call possible
//   * base URL without an explicit mode → advisory (dormancy is explicit)
//   * a 404/410 from Finance is a DEFINITIVE invalid (unknown-to-finance),
//     not an outage — enforce may block on it
//   * a transport failure / 5xx is UNREACHABLE — never invalid
//   * CLOSED status is invalid; OPEN inside the validity window is valid
import { jest } from "@jest/globals";

const OLD = {
  FINANCE_SERVICE_URL: process.env.FINANCE_SERVICE_URL,
  FINANCE_VALIDITY_MODE: process.env.FINANCE_VALIDITY_MODE,
};

beforeEach(() => {
  jest.resetModules();
});

afterAll(() => {
  if (OLD.FINANCE_SERVICE_URL === undefined) delete process.env.FINANCE_SERVICE_URL;
  else process.env.FINANCE_SERVICE_URL = OLD.FINANCE_SERVICE_URL;
  if (OLD.FINANCE_VALIDITY_MODE === undefined) delete process.env.FINANCE_VALIDITY_MODE;
  else process.env.FINANCE_VALIDITY_MODE = OLD.FINANCE_VALIDITY_MODE;
});

describe("financeClient — the contract client", () => {
  test("no FINANCE_SERVICE_URL → off mode, no outbound call possible", async () => {
    delete process.env.FINANCE_SERVICE_URL;
    const client = await import("../../src/lib/financeClient.js");
    const result = await client.checkCostCenterValidity("t1", "CC-1");
    expect(result).toMatchObject({ mode: "off", checked: false, valid: null });
    expect(await client.fetchBudgetAndHeadcount("t1", "CC-1")).toMatchObject({ checked: false, reason: "finance-service-not-configured" });
  });

  test("base URL set without an explicit mode → advisory (enforce is explicit only)", async () => {
    process.env.FINANCE_SERVICE_URL = "http://finance.test";
    delete process.env.FINANCE_VALIDITY_MODE;
    const client = await import("../../src/lib/financeClient.js");
    expect(client.financeValidityEnforced()).toBe(false);
  });

  test("404 from Finance is a DEFINITIVE invalid, not an outage", async () => {
    process.env.FINANCE_SERVICE_URL = "http://finance.test";
    process.env.FINANCE_VALIDITY_MODE = "enforce";
    const axios = (await import("axios")).default;
    const spy = jest.spyOn(axios, "create").mockReturnValue({
      get: jest.fn(async () => { const e = new Error("nf"); e.response = { status: 404 }; throw e; }),
    });
    const client = await import("../../src/lib/financeClient.js");
    const result = await client.checkCostCenterValidity("t1", "CC-404");
    expect(result).toMatchObject({ checked: true, valid: false, state: "unknown-to-finance" });
    spy.mockRestore();
  });

  test("transport failure is unverifiable — never invalid", async () => {
    process.env.FINANCE_SERVICE_URL = "http://finance.test";
    process.env.FINANCE_VALIDITY_MODE = "enforce";
    const axios = (await import("axios")).default;
    const spy = jest.spyOn(axios, "create").mockReturnValue({
      get: jest.fn(async () => { throw new Error("ECONNREFUSED"); }),
    });
    const client = await import("../../src/lib/financeClient.js");
    const result = await client.checkCostCenterValidity("t1", "CC-1");
    expect(result).toMatchObject({ checked: false, valid: null, state: "unverifiable" });
    spy.mockRestore();
  });

  test("CLOSED status is invalid; OPEN inside window is valid", async () => {
    process.env.FINANCE_SERVICE_URL = "http://finance.test";
    process.env.FINANCE_VALIDITY_MODE = "advisory";
    const axios = (await import("axios")).default;
    const now = new Date("2026-09-22T00:00:00Z");
    const spy = jest.spyOn(axios, "create").mockReturnValue({
      get: jest.fn()
        .mockResolvedValueOnce({ data: { costCenterId: "CC-1", status: "CLOSED", validFrom: null, validTo: null } })
        .mockResolvedValueOnce({ data: { costCenterId: "CC-2", status: "OPEN", validFrom: "2026-01-01", validTo: null } }),
    });
    const client = await import("../../src/lib/financeClient.js");
    expect(await client.checkCostCenterValidity("t1", "CC-1", now)).toMatchObject({ valid: false, state: "not-open-closed" });
    expect(await client.checkCostCenterValidity("t1", "CC-2", now)).toMatchObject({ valid: true, state: "valid" });
    spy.mockRestore();
  });
});
