import { describe, it, expect } from "@jest/globals";
import {
  runAttendanceImport,
  commitAttendanceImport,
} from "../../src/services/attendanceImport.service.js";
import { captureDb, TENANT, OTHER_TENANT } from "../helpers/captureDb.js";
const file =
  "employee_code,date,check_in,check_out\nEMP1,2026-10-01,22:00,06:00";
const preview = (db, extra = {}) =>
  runAttendanceImport(
    {
      tenantId: TENANT,
      actorId: "hr-1",
      fileBase64: Buffer.from(file).toString("base64"),
      format: "csv",
      approvalReference: "Historical register 42",
      ...extra,
    },
    db,
  );
const commit = (db, p, extra = {}) =>
  commitAttendanceImport(
    {
      tenantId: TENANT,
      actorId: "hr-1",
      batchId: p.batchId,
      previewToken: p.previewToken,
      reason: "Approved migration",
      ...extra,
    },
    db,
  );
describe("reviewed historical import", () => {
  it("preview writes no attendance; commit persists correct overnight checkout and provenance", async () => {
    const db = captureDb();
    const p = await preview(db);
    expect(db.snapshot().attendance).toHaveLength(0);
    expect((await commit(db, p)).done).toBe(true);
    const row = db.snapshot().attendance[0];
    expect(row.check_out.toISOString()).toBe("2026-10-02T06:00:00.000Z");
    expect(row.manually_corrected).toBe(true);
    expect(row.setupSnapshot).toMatchObject({
      source: "HISTORICAL_IMPORT",
      batchId: p.batchId,
      approvalReference: "Historical register 42",
    });
    await commit(db, p);
    expect(db.snapshot().attendance).toHaveLength(1);
  });
  it("rejects forged tokens, different operators and different tenants", async () => {
    const db = captureDb();
    const p = await preview(db);
    for (const extra of [
      { previewToken: "forged" },
      { actorId: "hr-2" },
      { tenantId: OTHER_TENANT },
    ])
      await expect(commit(db, p, extra)).rejects.toMatchObject({ status: 409 });
    expect(db.snapshot().attendance).toHaveLength(0);
  });
  it("does not overwrite a record created after the preview", async () => {
    const db = captureDb();
    const p = await preview(db);
    await db.attendance.create({
      data: {
        employeeId: 1,
        tenantId: TENANT,
        date: new Date("2026-10-01"),
        manually_corrected: true,
      },
    });
    await expect(commit(db, p)).rejects.toThrow(/changed after preview/);
    expect(db.snapshot().attendanceImportBatch[0].cursor).toBe(0);
  });
  it("blocks protected periods and retains the resumable batch", async () => {
    const db = captureDb({
      payrollRun: [
        {
          id: 1,
          tenantId: TENANT,
          periodStart: new Date("2026-10-01"),
          periodEnd: new Date("2026-10-31"),
          status: "FINALIZED",
        },
      ],
    });
    const p = await preview(db);
    await expect(commit(db, p)).rejects.toThrow(/PERIOD_PROTECTED/);
    expect(db.snapshot().attendance).toHaveLength(0);
    expect(db.snapshot().attendanceImportBatch).toHaveLength(1);
  });
  it("protects corrections unless replacement was explicitly previewed", async () => {
    const db = captureDb();
    await db.attendance.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        date: new Date("2026-10-01"),
        manually_corrected: true,
      },
    });
    const p = await preview(db);
    expect(p.summary.errors).toBe(1);
    await expect(commit(db, p)).rejects.toThrow(/preview errors/);
    const replacement = await preview(db, { replaceCorrected: true });
    expect(replacement.results[0].before.manually_corrected).toBe(true);
    await expect(commit(db, replacement)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await commit(db, replacement, { mayReplaceCorrected: true })).done,
    ).toBe(true);
  });
  it("requires approval evidence even for attendance-only historical rows", async () => {
    const db = captureDb();
    const p = await preview(db, { approvalReference: "" });
    await expect(commit(db, p)).rejects.toThrow(/approval reference/);
  });
});

describe("import recovery and CSV boundaries", () => {
  it("resumes beyond a committed 100-row chunk without duplicating decisions", async () => {
    const db = captureDb();
    const content =
      "employee_code,date,check_in,check_out\n" +
      Array.from(
        { length: 101 },
        (_, i) =>
          `EMP1,${new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)},09:00,18:00`,
      ).join("\n");
    const p = await preview(db, {
      fileBase64: Buffer.from(content).toString("base64"),
    });
    expect((await commit(db, p)).cursor).toBe(100);
    expect(db.snapshot().attendance).toHaveLength(100);
    expect((await commit(db, p)).done).toBe(true);
    expect(db.snapshot().attendance).toHaveLength(101);
    await commit(db, p);
    expect(db.snapshot().attendance).toHaveLength(101);
  });
  it("refuses a concurrent version change during the commit write", async () => {
    const db = captureDb();
    await db.attendance.create({
      data: {
        tenantId: TENANT,
        employeeId: 1,
        date: new Date("2026-10-01"),
        status: "ABSENT",
      },
    });
    const p = await preview(db);
    db.attendance.updateMany = async () => ({ count: 0 });
    await expect(commit(db, p)).rejects.toThrow(/changed during commit/);
    expect(db.snapshot().attendanceImportBatch[0].cursor).toBe(0);
    expect(db.snapshot().attendance[0].status).toBe("ABSENT");
  });
  it("preserves multiline quoted CSV remarks and refuses malformed quotes", async () => {
    const db = captureDb();
    const content =
      'employee_code,date,check_in,check_out,remarks\nEMP1,2026-10-01,09:00,18:00,"Approved, register\npage 42"';
    const p = await preview(db, {
      fileBase64: Buffer.from(content).toString("base64"),
    });
    expect(p.summary.errors).toBe(0);
    await commit(db, p);
    expect(db.snapshot().attendance[0].remarks).toContain(
      "Approved, register\npage 42",
    );
    await expect(
      preview(db, {
        fileBase64: Buffer.from(content.slice(0, -1)).toString("base64"),
      }),
    ).rejects.toThrow(/unclosed quoted/);
  });
});
