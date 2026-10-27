import { describe, it, expect } from "@jest/globals";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeFixture } from "../fixtures/native-verification.js";
import { nativeDigest, nativeProvisioningKey } from "../../src/lib/native-verification-plan.js";
import {
  validateHrNativeDispatch,
  nativeRbacReceiptFingerprint,
  writeCleanupArtifact,
  publishNativeResult,
} from "../../scripts/native-verification-grant.mjs";

function dispatchFixture() {
  const f = nativeFixture(),
    bytes = Buffer.from(JSON.stringify(f.plan));
  const dispatch = {
    version: 1,
    operation: "INSTALL",
    planSha256: createHash("sha256").update(bytes).digest("hex"),
    planFingerprint: nativeDigest(f.plan),
    grantId: f.plan.grantId,
    runId: f.plan.runId,
    tenantId: f.plan.tenantId,
    operatorOrigin: f.plan.operatorOrigin,
    dispatch: {
      ...f.plan.operatorOrigin,
      jobUid: randomUUID(),
      podUid: randomUUID(),
      jobName: "sdlc-native-hr-install-test",
    },
    rbacAuthorization: {
      id: "123",
      fingerprint: nativeRbacReceiptFingerprint(f.plan, "BOOTSTRAP_AUTHORIZATION", "123"),
    },
    rbacCancellation: null,
    operationRef: "test:controller:20261023:install",
  };
  const env = {
    SDLC_OPERATOR_NAMESPACE: dispatch.dispatch.namespace,
    SDLC_OPERATOR_JOB_NAME: dispatch.dispatch.jobName,
    SDLC_OPERATOR_JOB_UID: dispatch.dispatch.jobUid,
    SDLC_OPERATOR_POD_UID: dispatch.dispatch.podUid,
  };
  return { ...f, dispatch, bytes, env };
}
const validate = (f) => validateHrNativeDispatch(f.dispatch, f.bytes, f.env, f.now);
describe("native HR private controller dispatch", () => {
  const outputFixture = (operation = "CANCEL") => {
    const f = dispatchFixture();
    f.dispatch.operation = operation;
    if (operation === "CANCEL")
      f.dispatch.rbacCancellation = {
        id: "124",
        grantId: f.plan.grantId,
        fingerprint: nativeRbacReceiptFingerprint(f.plan, "BOOTSTRAP_CANCELLED", "124", "123"),
      };
    const entry = {
      entryId: f.entry.entryId,
      employeeId: 101,
      provisioningId: randomUUID(),
      idempotencyKey: nativeProvisioningKey(f.plan.tenantId, 101),
      payloadFingerprint: "a".repeat(64),
      deactivationReceiptId: operation === "CANCEL" ? randomUUID() : null,
    };
    return {
      authorized: { plan: f.plan, dispatch: f.dispatch },
      result: {
        state: operation === "CANCEL" ? "CANCELLED" : "INSTALLED",
        grantId: f.plan.grantId,
        entries: [entry],
      },
      receipts:
        operation === "CANCEL"
          ? [{ entryId: entry.entryId, token: "synthetic-private-token" }]
          : null,
    };
  };
  it("publishes full authoritative result only after complete private artifact publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-result-test-"));
    try {
      const input = outputFixture(),
        summary = await publishNativeResult({ ...input, directory });
      const bytes = await readFile(join(directory, "hr-native-cleanup.json"));
      expect(summary).toEqual({
        version: 1,
        operation: "CANCEL",
        operationRef: input.authorized.dispatch.operationRef,
        state: "CANCELLED",
        grantId: input.result.grantId,
        planFingerprint: nativeDigest(input.authorized.plan),
        rbacAuthorization: input.authorized.dispatch.rbacAuthorization,
        rbacCancellation: input.authorized.dispatch.rbacCancellation,
        ownedEmployeeCount: 1,
        entries: input.result.entries,
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(JSON.parse(await readFile(join(directory, "result.json"), "utf8"))).toEqual(summary);
      expect((await stat(join(directory, "result.json"))).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(summary)).not.toContain("synthetic-private-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("publishes INSTALL with explicit null cancellation, artifact and deactivation fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-install-result-"));
    try {
      const input = outputFixture("INSTALL"),
        summary = await publishNativeResult({ ...input, directory });
      expect(summary).toMatchObject({
        operation: "INSTALL",
        state: "INSTALLED",
        artifactSha256: null,
        rbacCancellation: null,
        ownedEmployeeCount: 1,
      });
      expect(summary.entries[0].deactivationReceiptId).toBeNull();
      expect(await readdir(directory)).toEqual(["result.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("never publishes success when identity coverage or private publication fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-incomplete-test-"));
    try {
      const input = outputFixture();
      await expect(publishNativeResult({ ...input, receipts: [], directory })).rejects.toThrow();
      await expect(
        publishNativeResult({
          ...input,
          result: { ...input.result, entries: [...input.result.entries, ...input.result.entries] },
          directory,
        }),
      ).rejects.toThrow();
      await expect(
        publishNativeResult({
          ...input,
          result: {
            ...input.result,
            entries: [{ ...input.result.entries[0], provisioningId: "wrong" }],
          },
          directory,
        }),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
      await writeCleanupArtifact({ preserved: true }, directory);
      await expect(publishNativeResult({ ...input, directory })).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["hr-native-cleanup.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("distinguishes original bootstrap origin from observed HR job identity", () => {
    const f = dispatchFixture();
    expect(f.dispatch.dispatch.podUid).not.toBe(f.plan.operatorOrigin.podUid);
    expect(validate(f).plan).toEqual(f.plan);
  });
  it.each(["planSha256", "planFingerprint", "grantId", "runId", "tenantId"])(
    "rejects changed %s",
    (key) => {
      const f = dispatchFixture();
      f.dispatch[key] = "changed";
      expect(() => validate(f)).toThrow();
    },
  );
  it.each([
    "SDLC_OPERATOR_NAMESPACE",
    "SDLC_OPERATOR_JOB_NAME",
    "SDLC_OPERATOR_JOB_UID",
    "SDLC_OPERATOR_POD_UID",
  ])("rejects observed identity mismatch %s", (key) => {
    const f = dispatchFixture();
    f.env[key] = "different";
    expect(() => validate(f)).toThrow();
  });
  it.each(["0", "01", "2147483648", "1e2", "-1"])(
    "rejects noncanonical/out-of-range RBAC Log ID %s",
    (id) => {
      const f = dispatchFixture();
      f.dispatch.rbacAuthorization.id = id;
      expect(() => validate(f)).toThrow();
    },
  );
  it("does not confuse plan fingerprints with actual RBAC receipt fingerprints", () => {
    const f = dispatchFixture();
    f.dispatch.rbacAuthorization.fingerprint = nativeDigest(f.plan);
    expect(() => validate(f)).toThrow();
  });
  it("requires the separately committed cancellation receipt before accepting expired cleanup", () => {
    const f = dispatchFixture();
    f.dispatch.operation = "CANCEL";
    f.now = new Date(Date.parse(f.plan.expiresAt) + 1000);
    expect(() => validate(f)).toThrow();
    f.dispatch.rbacCancellation = {
      id: "124",
      grantId: f.plan.grantId,
      fingerprint: nativeRbacReceiptFingerprint(f.plan, "BOOTSTRAP_CANCELLED", "124", "123"),
    };
    expect(validate(f).plan.grantId).toBe(f.plan.grantId);
    f.dispatch.rbacCancellation.fingerprint = nativeRbacReceiptFingerprint(
      f.plan,
      "BOOTSTRAP_CANCELLED",
      "124",
      "999",
    );
    expect(() => validate(f)).toThrow();
  });
  it("writes only a complete private artifact and refuses to overwrite an existing receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-cleanup-test-"));
    try {
      const value = {
        grantId: randomUUID(),
        receipts: [{ entryId: randomUUID(), token: "synthetic-token" }],
      };
      await writeCleanupArtifact(value, directory);
      expect((await stat(join(directory, "hr-native-cleanup.json"))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(directory, "hr-native-cleanup.json"), "utf8"))).toEqual(
        value,
      );
      await expect(writeCleanupArtifact({ changed: true }, directory)).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["hr-native-cleanup.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
