import { captureError } from "../lib/attendanceCapture.js";

const expectedEngine = (modality) =>
  modality === "FACE" ? "INSIGHTFACE" : "SOURCEAFIS";
export async function callBiometricEngine(
  modality,
  operation,
  body,
  fetchImpl = fetch,
) {
  const prefix = modality === "FACE" ? "INSIGHTFACE" : "SOURCEAFIS";
  const address = process.env[`${prefix}_URL`];
  const token = process.env.BIOMETRIC_ENGINE_TOKEN;
  if (!address || !token || token.length < 32)
    throw captureError(`${prefix} service is not configured`, 503);
  let url;
  try {
    url = new URL(address);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error();
  } catch {
    throw captureError(
      "Recognition services require HTTPS or a loopback endpoint",
      503,
    );
  }
  url.pathname = `/${operation}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error();
    const data = JSON.parse(text);
    if (!response.ok) {
      if (response.status === 422)
        throw captureError(
          "Biometric sample quality or template compatibility check failed",
          422,
        );
      throw new Error();
    }
    if (
      data.engine !== expectedEngine(modality) ||
      typeof data.engineVersion !== "string" ||
      !data.engineVersion ||
      data.engineVersion.length > 200
    )
      throw new Error();
    if (
      operation === "extract" &&
      (typeof data.template !== "string" ||
        !data.template ||
        data.template.length > 700000)
    )
      throw new Error();
    if (
      operation === "match" &&
      (!Number.isFinite(data.score) ||
        (modality === "FACE" && (data.score < -1 || data.score > 1)) ||
        (modality === "FINGERPRINT" && data.score < 0))
    )
      throw new Error();
    return data;
  } catch (err) {
    if (err.status === 422) throw err;
    throw captureError(`${prefix} recognition service is unavailable`, 503);
  }
}
