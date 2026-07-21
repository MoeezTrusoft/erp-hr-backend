import axios from "axios";
import FormData from "form-data";
import logger from "../lib/logger.js";
import { ambientTenantHeader } from "../lib/serviceJwt.js";

const DAM_BASE_URL = process.env.DAM_SERVICE_URL || "http://localhost:3002/api";
const DAM_TIMEOUT = parseInt(process.env.DAM_SERVICE_TIMEOUT || "1000000", 10);

const damApi = axios.create({
  baseURL: DAM_BASE_URL,
  timeout: DAM_TIMEOUT,
});

// DAM authenticates internal callers by X-Internal-Secret ALONE. Attaching an
// HR-signed X-Service-Authorization JWT (HS256, self-issuer) that DAM cannot
// verify makes it hard-401 "Invalid service token" — so we deliberately do NOT
// send it. (Same reason uploadFileToDAM sends the secret only.) Since there is
// no verifiable JWT to carry a tid claim to DAM, the ambient tenant rides as a
// trusted X-Tenant-Id header, which DAM's legacy-secret lane now reads.
const withInternalSecret = (headers = {}) => ({
    ...headers,
    ...ambientTenantHeader(),
    "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
});

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
        timeout: DAM_TIMEOUT,
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

    // ONLY the internal secret — DAM hard-401s ("Invalid service token") when an
    // HR-signed X-Service-Authorization JWT it can't verify is also present.
    const res = await fetch(`${DAM_BASE_URL.replace(/\/+$/, "")}/assets/upload`, {
      method: "POST",
      headers: { ...ambientTenantHeader(), "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET },
      body: fd,
    });
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

