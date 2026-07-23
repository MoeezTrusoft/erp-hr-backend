import axios from "axios";
import FormData from "form-data";
import logger from "../lib/logger.js";
import { ambientTenantHeader, signServiceJwtEdDSA } from "../lib/serviceJwt.js";

const DAM_BASE_URL = process.env.DAM_SERVICE_URL || "http://localhost:3002/api";
// RES-2: bound every cross-boundary DAM call. The legacy DAM_SERVICE_TIMEOUT
// default was 1_000_000ms (~16.6 min) — effectively unbounded, so a stalled DAM
// upstream could hang an HR request indefinitely. We now use two conservative,
// env-tunable budgets (DAM_SERVICE_TIMEOUT is still honoured as a fallback for
// existing deployments):
//   * DAM_HTTP_TIMEOUT_MS        (default 10s) — metadata / GET / normal requests
//   * DAM_HTTP_UPLOAD_TIMEOUT_MS (default 30s) — multipart uploads + byte downloads
const DAM_TIMEOUT = parseInt(process.env.DAM_HTTP_TIMEOUT_MS || process.env.DAM_SERVICE_TIMEOUT || "10000", 10);
const DAM_UPLOAD_TIMEOUT = parseInt(process.env.DAM_HTTP_UPLOAD_TIMEOUT_MS || "30000", 10);

const damApi = axios.create({
  baseURL: DAM_BASE_URL,
  timeout: DAM_TIMEOUT,
});

// DAM now authenticates HR on the EdDSA service-JWT plane: it verifies the
// X-Service-Authorization token against HR's registered public key (kid
// hr-svc-45d91377) and only falls back to X-Internal-Secret when NO service JWT
// is present. So we attach BOTH — the same EdDSA token rbac.client.js sends
// (signServiceJwtEdDSA, carrying a tid claim), plus X-Internal-Secret as the
// retained legacy fallback and the ambient X-Tenant-Id header for defense in
// depth. NOTE: DAM does not silently downgrade — if a service JWT is present
// but invalid it 401s even with a valid secret, so the token must be a genuine
// HR EdDSA token (aud "internal", iss "erp-hr").
const withInternalSecret = (headers = {}) => {
    const merged = {
        ...headers,
        ...ambientTenantHeader(),
        "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
    };
    const token = signServiceJwtEdDSA(); // DAM verifies HR on the EdDSA plane (kid hr-svc-45d91377)
    if (token) merged["X-Service-Authorization"] = `Bearer ${token}`;
    return merged;
};

export async function damRequest(endpoint, method = "GET", body = {}, headers = {}) {
    try {
        const response = await damApi.request({
            url: endpoint.startsWith("/") ? endpoint : `/${endpoint}`,
            method: method.toUpperCase(),
            data: ["POST", "PUT", "PATCH"].includes(method.toUpperCase()) ? body : undefined,
            headers: withInternalSecret(headers),
        });
        return response.data;
    } catch (error) {
        logger.error({
            err: error,
            method,
            endpoint,
            responseData: error.response?.data,
        }, "DAM upstream request failed");
        return null;
    }
}

export function normalizeDamAssetResponse(payload) {
  if (!payload) return null;
  if (payload.data) return payload.data;
  if (payload.media) return payload.media;
  if (Array.isArray(payload.items) && payload.items.length > 0) return payload.items[0];
  if (Array.isArray(payload) && payload.length > 0) return payload[0];
  return payload;
}

export async function getDamAssetById(mediaId) {
  const direct = await damRequest(`/assets/${mediaId}`, "GET");
  const normalizedDirect = normalizeDamAssetResponse(direct);
  if (normalizedDirect) return normalizedDirect;

  const downloaded = await damRequest(`/assets/download/${mediaId}`, "GET");
  return normalizeDamAssetResponse(downloaded);
}

/**
 * Download the raw bytes of a DAM asset (for AI resume parsing).
 * Strategy: resolve asset metadata → try each candidate URL as arraybuffer;
 * fall back to the DAM stream endpoint (302 → presigned URL, axios follows it).
 * Returns { buffer, mimeType, fileName } or null on failure (fail-soft).
 *
 * @param {string|number} mediaId
 */
export async function downloadDamAssetBuffer(mediaId) {
  if (!mediaId) return null;
  const asset = await getDamAssetById(mediaId);
  const fileName = asset?.file_name || asset?.filename || asset?.originalname || `asset-${mediaId}`;
  const mimeType = asset?.mime_type || asset?.mimetype || asset?.contentType || null;

  const candidates = [asset?.url, asset?.file_url, asset?.download_url, asset?.cdn_url].filter(
    (u) => typeof u === "string" && /^https?:\/\//i.test(u)
  );

  for (const url of candidates) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: DAM_UPLOAD_TIMEOUT, // RES-2: byte download — allow the larger budget
        headers: withInternalSecret(),
        maxRedirects: 5,
      });
      if (res?.data) {
        return { buffer: Buffer.from(res.data), mimeType: res.headers?.["content-type"] || mimeType, fileName };
      }
    } catch (err) {
      logger.warn({ err: err?.message, mediaId, url }, "DAM asset URL download failed — trying next source");
    }
  }

  // Fallback: DAM stream endpoint 302-redirects to a short-lived presigned URL.
  try {
    const res = await damApi.get(`/assets/video-stream/${mediaId}`, {
      responseType: "arraybuffer",
      timeout: DAM_UPLOAD_TIMEOUT, // RES-2: byte download — allow the larger budget
      headers: withInternalSecret(),
      maxRedirects: 5,
    });
    if (res?.data) {
      return { buffer: Buffer.from(res.data), mimeType: res.headers?.["content-type"] || mimeType, fileName };
    }
  } catch (err) {
    logger.error({ err: err?.message, mediaId }, "DAM asset stream download failed");
  }

  return null;
}

export async function uploadFileToDAM(file, type = "avatar") {
  try {
    // Use native fetch + FormData/Blob — the form-data npm lib's multipart
    // (via axios) is not parsed by DAM's busboy (req.file stays undefined →
    // upload yields no asset). Native multipart works reliably.
    const fd = new globalThis.FormData(); // native (the top-level `form-data` import shadows FormData)
    fd.append("type", type);
    fd.append("source", "HR-TruSoft");
    // Unique per upload so DAM's Usage @@unique([source, externalId]) doesn't
    // collapse every HR asset onto one usage row (was hardcoded 123).
    fd.append("externalId", `hr-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
    fd.append(
      "files",
      new globalThis.Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
      file.originalname || "upload.bin"
    );

    // Attach the EdDSA service JWT (DAM verifies HR on the EdDSA plane) plus the
    // retained X-Internal-Secret fallback and ambient tenant header — same auth
    // shape as withInternalSecret above. (fetch, not axios, so we build headers
    // inline here; the token/secret/tenant channels are identical.)
    //
    // RES-2: native fetch has NO built-in timeout, so an unresponsive DAM would
    // hang this upload forever. Bound it with an AbortController + setTimeout
    // (DAM_HTTP_UPLOAD_TIMEOUT_MS, default 30s). The timer is always cleared in
    // `finally` so no timer leaks whether the upload succeeds, errors, or aborts.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), DAM_UPLOAD_TIMEOUT);
    let res;
    try {
      res = await fetch(`${DAM_BASE_URL.replace(/\/+$/, "")}/assets/upload`, {
        method: "POST",
        headers: withInternalSecret(),
        body: fd,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    if (!res.ok) {
      logger.error({ status: res.status, body: (await res.text()).slice(0, 300) }, "DAM upload failed");
      return [];
    }
    const json = await res.json();
    return json?.items || [];
  } catch (err) {
    logger.error({ err }, "DAM upload failed");
    return [];
  }
}

