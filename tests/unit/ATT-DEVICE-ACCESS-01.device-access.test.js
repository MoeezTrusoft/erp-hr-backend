// ATT-DEVICE-ACCESS-01 — companies configure the devices they use themselves.
// A company requests another company's device; only the device-owning company
// can approve. Approval adds the requester to the device's allowed companies;
// either side can end the access later. Every change is audited.
import { describe, it, expect, beforeEach } from "@jest/globals";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";
import {
  requestDeviceAccess,
  decideDeviceAccess,
  withdrawDeviceAccessRequest,
  endDeviceAccess,
  listDeviceAccess,
} from "../../src/services/attendanceDeviceAccess.service.js";

const OWNER = TENANT;
const REQUESTER = OTHER_TENANT;
const THIRD = "30000000-0000-4000-8000-000000000003";
let db;
const device = () => db.snapshot().attendanceCaptureDevice[0];
beforeEach(() => {
  db = captureDb({
    attendanceCaptureDevice: [
      {
        id: "dddddddd-0000-4000-8000-000000000001",
        tenantId: OWNER,
        sn: "DEVICE-1",
        name: "Reception",
        timeZone: "Asia/Karachi",
        allowedTenantIds: [OWNER],
        active: true,
        credentialHash: "secret-hash",
        staleAfterMinutes: 30,
      },
    ],
    attendanceDeviceAccessRequest: [],
  });
});
const ask = (over = {}) =>
  requestDeviceAccess(
    { tenantId: REQUESTER, actorId: "hr-b", sn: "DEVICE-1", reason: "Staff punch at this site", ...over },
    db,
  );
const decide = (request, decision, over = {}) =>
  decideDeviceAccess(
    { tenantId: OWNER, actorId: "hr-a", id: request.id, version: request.version, decision, reason: "Reviewed", ...over },
    db,
  );

describe("requesting a device", () => {
  it("records a pending request without changing the device", async () => {
    const request = await ask();
    expect(request).toMatchObject({
      tenantId: REQUESTER,
      ownerTenantId: OWNER,
      sn: "DEVICE-1",
      state: "PENDING",
      requestedBy: "hr-b",
    });
    expect(device().allowedTenantIds).toEqual([OWNER]);
    expect(db.snapshot().outboxEvent.map((e) => e.eventName)).toContain(
      "hr.attendance.device_access_requested.v1",
    );
  });
  it("refuses a second open request from the same company", async () => {
    await ask();
    await expect(ask()).rejects.toMatchObject({ status: 409 });
  });
  it("refuses a company that already uses the device", async () => {
    await db.attendanceCaptureDevice.updateMany({
      where: { sn: "DEVICE-1" },
      data: { allowedTenantIds: [OWNER, REQUESTER] },
    });
    await expect(ask()).rejects.toMatchObject({ status: 409 });
  });
  it("the owner does not request its own device", async () => {
    await expect(ask({ tenantId: OWNER })).rejects.toMatchObject({ status: 409 });
  });
  it("an unknown or inactive device is not found", async () => {
    await expect(ask({ sn: "NOPE" })).rejects.toMatchObject({ status: 404 });
    await db.attendanceCaptureDevice.updateMany({ where: { sn: "DEVICE-1" }, data: { active: false } });
    await expect(ask()).rejects.toMatchObject({ status: 404 });
  });
  it("a reason is required", async () => {
    await expect(ask({ reason: "  " })).rejects.toMatchObject({ status: 400 });
  });
});

describe("the owner decides", () => {
  it("approval adds the company to the device and is audited", async () => {
    const approved = await decide(await ask(), "APPROVE");
    expect(approved).toMatchObject({ state: "APPROVED", decidedBy: "hr-a" });
    expect(device().allowedTenantIds.sort()).toEqual([OWNER, REQUESTER].sort());
    expect(
      db.snapshot().attendanceCaptureAudit.find((a) => a.action === "DEVICE_ROUTING_CHANGED"),
    ).toMatchObject({ tenantId: OWNER, actorId: "hr-a" });
  });
  it("rejection leaves the device unchanged", async () => {
    expect(await decide(await ask(), "REJECT")).toMatchObject({ state: "REJECTED" });
    expect(device().allowedTenantIds).toEqual([OWNER]);
  });
  it("the requesting company cannot decide its own request", async () => {
    await expect(decide(await ask(), "APPROVE", { tenantId: REQUESTER })).rejects.toMatchObject({
      status: 403,
    });
    expect(device().allowedTenantIds).toEqual([OWNER]);
  });
  it("an unrelated company cannot see or decide the request", async () => {
    await expect(decide(await ask(), "APPROVE", { tenantId: THIRD })).rejects.toMatchObject({
      status: 404,
    });
  });
  it("a stale version is refused", async () => {
    const request = await ask();
    await expect(decide(request, "APPROVE", { version: request.version + 1 })).rejects.toMatchObject({
      status: 409,
    });
  });
  it("a decided request cannot be decided again", async () => {
    const approved = await decide(await ask(), "APPROVE");
    await expect(decide(approved, "REJECT")).rejects.toMatchObject({ status: 409 });
  });
});

describe("ending access", () => {
  it("the requester can withdraw a pending request", async () => {
    const request = await ask();
    expect(
      await withdrawDeviceAccessRequest(
        { tenantId: REQUESTER, actorId: "hr-b", id: request.id, version: request.version, reason: "No longer needed" },
        db,
      ),
    ).toMatchObject({ state: "WITHDRAWN" });
    await expect(ask()).resolves.toMatchObject({ state: "PENDING" });
  });
  it("the owner can revoke a company's access", async () => {
    await decide(await ask(), "APPROVE");
    await endDeviceAccess(
      { tenantId: OWNER, actorId: "hr-a", sn: "DEVICE-1", companyTenantId: REQUESTER, reason: "Site closed" },
      db,
    );
    expect(device().allowedTenantIds).toEqual([OWNER]);
    expect(db.snapshot().attendanceDeviceAccessRequest[0]).toMatchObject({
      state: "REVOKED",
      endedBy: "hr-a",
    });
  });
  it("the owner can revoke access granted before requests existed", async () => {
    await db.attendanceCaptureDevice.updateMany({
      where: { sn: "DEVICE-1" },
      data: { allowedTenantIds: [OWNER, REQUESTER] },
    });
    await endDeviceAccess(
      { tenantId: OWNER, actorId: "hr-a", sn: "DEVICE-1", companyTenantId: REQUESTER, reason: "Tidy up" },
      db,
    );
    expect(device().allowedTenantIds).toEqual([OWNER]);
  });
  it("a company can give up its own access", async () => {
    await decide(await ask(), "APPROVE");
    await endDeviceAccess({ tenantId: REQUESTER, actorId: "hr-b", sn: "DEVICE-1", reason: "Moved site" }, db);
    expect(device().allowedTenantIds).toEqual([OWNER]);
  });
  it("the owner can never be removed from its own device", async () => {
    await expect(
      endDeviceAccess(
        { tenantId: OWNER, actorId: "hr-a", sn: "DEVICE-1", companyTenantId: OWNER, reason: "Oops" },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("only the owner can remove another company", async () => {
    await decide(await ask(), "APPROVE");
    const removeRequester = (tenantId) =>
      endDeviceAccess(
        { tenantId, actorId: "hr-c", sn: "DEVICE-1", companyTenantId: REQUESTER, reason: "Hostile" },
        db,
      );
    // A company that does not use the device cannot even see it.
    await expect(removeRequester(THIRD)).rejects.toMatchObject({ status: 404 });
    // A company that also uses the device still cannot remove another one.
    await db.attendanceCaptureDevice.updateMany({
      where: { sn: "DEVICE-1" },
      data: { allowedTenantIds: [OWNER, REQUESTER, THIRD] },
    });
    await expect(removeRequester(THIRD)).rejects.toMatchObject({ status: 403 });
    expect(device().allowedTenantIds).toContain(REQUESTER);
  });
});

describe("what each company sees", () => {
  it("lists owned devices, shared devices and both directions of requests", async () => {
    await decide(await ask(), "APPROVE");
    const owner = await listDeviceAccess({ tenantId: OWNER }, db);
    expect(owner.owned).toHaveLength(1);
    expect(owner.owned[0]).toMatchObject({ sn: "DEVICE-1", allowedTenantIds: expect.arrayContaining([REQUESTER]) });
    expect(owner.incoming).toHaveLength(1);
    expect(owner.outgoing).toHaveLength(0);
    const requester = await listDeviceAccess({ tenantId: REQUESTER }, db);
    expect(requester.used).toEqual([
      expect.objectContaining({ sn: "DEVICE-1", ownerTenantId: OWNER }),
    ]);
    expect(requester.used[0].credentialHash).toBeUndefined();
    expect(requester.used[0].allowedTenantIds).toBeUndefined();
    expect(requester.outgoing).toHaveLength(1);
    const third = await listDeviceAccess({ tenantId: THIRD }, db);
    expect(third).toEqual({ owned: [], used: [], incoming: [], outgoing: [] });
  });
});
