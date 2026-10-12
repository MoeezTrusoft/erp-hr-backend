import { afterEach, beforeEach, expect, it } from "@jest/globals";
import { callBiometricEngine } from "../../src/services/biometricEngine.client.js";
let original;
beforeEach(() => {
  original = { ...process.env };
  process.env.INSIGHTFACE_URL = "http://127.0.0.1:8091";
  process.env.SOURCEAFIS_URL = "http://127.0.0.1:8092";
  process.env.BIOMETRIC_ENGINE_TOKEN = "test-token-012345678901234567890123456";
});
afterEach(() => {
  for (const key of [
    "INSIGHTFACE_URL",
    "SOURCEAFIS_URL",
    "BIOMETRIC_ENGINE_TOKEN",
  ]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});
const response =
  (body, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });
it("uses authenticated bounded private requests and validates engine identity", async () => {
  const fetch = async (url, request) => {
    expect(url.href).toBe("http://127.0.0.1:8091/extract");
    expect(request.redirect).toBe("error");
    expect(request.headers.Authorization).toBe(
      `Bearer ${process.env.BIOMETRIC_ENGINE_TOKEN}`,
    );
    return new Response(
      JSON.stringify({
        engine: "INSIGHTFACE",
        engineVersion: "model-v1",
        template: "embedding",
      }),
    );
  };
  expect(
    (await callBiometricEngine("FACE", "extract", {}, fetch)).template,
  ).toBe("embedding");
  await expect(
    callBiometricEngine(
      "FACE",
      "match",
      {},
      response({ engine: "SOURCEAFIS", engineVersion: "v1", score: 0.9 }),
    ),
  ).rejects.toMatchObject({ status: 503 });
});
it("rejects cleartext remote servers, malformed scores and redirects", async () => {
  process.env.INSIGHTFACE_URL = "http://remote-host:8091";
  await expect(callBiometricEngine("FACE", "match", {})).rejects.toMatchObject({
    status: 503,
  });
  process.env.INSIGHTFACE_URL = "http://127.0.0.1:8091";
  for (const score of [null, "0.99", 3])
    await expect(
      callBiometricEngine(
        "FACE",
        "match",
        {},
        response({ engine: "INSIGHTFACE", engineVersion: "v1", score }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  await expect(
    callBiometricEngine("FACE", "match", {}, response({}, 302)),
  ).rejects.toMatchObject({ status: 503 });
});
it("separates sample rejection from an unavailable engine without leaking upstream bodies", async () => {
  for (const status of [422, 500]) {
    await expect(
      callBiometricEngine(
        "FINGERPRINT",
        "extract",
        {},
        response({ error: "PRIVATE-UPSTREAM-DATA" }, status),
      ),
    ).rejects.toMatchObject({ status: status === 422 ? 422 : 503 });
    await expect(
      callBiometricEngine(
        "FINGERPRINT",
        "extract",
        {},
        response({ error: "PRIVATE-UPSTREAM-DATA" }, status),
      ),
    ).rejects.not.toThrow("PRIVATE-UPSTREAM-DATA");
  }
});
