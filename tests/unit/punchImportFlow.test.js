import { describe, expect, it } from "@jest/globals";
import { commitPunchImport, previewPunchImport } from "../../src/services/attendancePunchImport.service.js";
import { captureDb, TENANT } from "../helpers/captureDb.js";

const FILE = "User ID,Time,Status\n101,2026-10-01 09:00:00,0\n101,2026-10-01 17:00:00,1\n999,2026-10-01 09:05:00,0\nbad,line\n";

describe("historical punch import", () => {
  it("previews without saving and reports unmatched IDs and bad rows", async () => {
    const db = captureDb();
    const r = await previewPunchImport({ tenantId: TENANT, sn: "DEVICE-1", text: FILE }, db);
    expect(r).toMatchObject({ punches: 3, invalid: 1, from: "2026-10-01", to: "2026-10-01", distinctIds: 2 });
    expect(r.unmatched.map((u) => u.deviceUserId)).toContain("999");
    expect(db.snapshot().attendanceCaptureEvent ?? []).toHaveLength(0);
  });
  it("refuses a commit without a reason, with bad rows, or with a stale token", async () => {
    const db = captureDb();
    const ok = "101,2026-10-01 09:00:00,0\n";
    const p = await previewPunchImport({ tenantId: TENANT, sn: "DEVICE-1", text: ok }, db);
    await expect(commitPunchImport({ tenantId: TENANT, sn: "DEVICE-1", text: ok, previewToken: p.previewToken, reason: " " }, db)).rejects.toThrow(/reason/);
    await expect(commitPunchImport({ tenantId: TENANT, sn: "DEVICE-1", text: FILE, previewToken: p.previewToken, reason: "x" }, db)).rejects.toThrow(/invalid rows/);
    await expect(commitPunchImport({ tenantId: TENANT, sn: "DEVICE-1", text: ok, previewToken: "0".repeat(64), reason: "x" }, db)).rejects.toThrow(/preview again/);
  });
  it("stores the previewed punches once, even when sent twice", async () => {
    const db = captureDb();
    const ok = "101,2026-10-01 09:00:00,0\n101,2026-10-01 17:00:00,1\n";
    const p = await previewPunchImport({ tenantId: TENANT, sn: "DEVICE-1", text: ok }, db);
    const args = { tenantId: TENANT, sn: "DEVICE-1", text: ok, previewToken: p.previewToken, reason: "Back-fill October", actorId: "hr" };
    const a = await commitPunchImport(args, db);
    expect(a).toMatchObject({ received: 2, stored: 2, chunks: 1 });
    const b = await commitPunchImport(args, db);
    expect(b.stored + b.duplicates).toBe(2);
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(2);
  });
});
