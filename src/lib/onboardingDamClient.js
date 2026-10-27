import { HR_ERRORS } from "../constants/errorCodes.js";
import { createHash } from "node:crypto";
import { signServiceJwtEdDSA } from "./serviceJwt.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ONBOARDING_DOCUMENT_LIMIT = 5 * 1024 * 1024;
const PDF = "application/pdf",
  DOCX =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const documentHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function documentFailure(message, status = 422) {
  return Object.assign(new Error(message), {
    status,
    code:
      status === 422
        ? HR_ERRORS.ONBOARDING_DOCUMENT_VALIDATION.code
        : status === 404
          ? "HR-4040"
          : status === 403
            ? "HR-4030"
            : status === 401
              ? "HR-4010"
              : status === 412
                ? "HR-4120"
                : status >= 500
                  ? HR_ERRORS.ONBOARDING_DOCUMENT_UNAVAILABLE.code
                  : "HR-4090",
  });
}
export function inspectOnboardingDocument(bytes, { signed = false } = {}) {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > (signed ? 16 * 1024 * 1024 : ONBOARDING_DOCUMENT_LIMIT)
  )
    throw documentFailure(
      signed
        ? "Signed PDF exceeds the storage limit"
        : "Choose a document of 5 MB or less",
    );
  if (bytes.subarray(0, 5).toString() === "%PDF-") return PDF;
  if (
    !signed &&
    bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) &&
    bytes.includes(Buffer.from("word/document.xml")) &&
    bytes.includes(Buffer.from("[Content_Types].xml"))
  )
    return DOCX;
  throw documentFailure("Choose a PDF or Word document");
}
export function verifyOnboardingAsset(
  asset,
  { tenantId, checklistId, mediaId, sha256, mimeType, byteSize },
  { clean = true, now = new Date() } = {},
) {
  if (
    !asset ||
    asset.tenantId !== tenantId ||
    asset.isDeleted ||
    Number(asset.id) !== mediaId
  )
    throw documentFailure("Onboarding document not found", 404);
  if (
    asset.accessStrategy !== "INHERITED" ||
    asset.parentType !== "OTHER" ||
    asset.parentId !== "hr-onboarding:" + checklistId ||
    asset.managedBy !== (process.env.SERVICE_JWT_SELF_ISSUER || "erp-hr")
  )
    throw documentFailure(
      "The document is not protected by its onboarding checklist",
      409,
    );
  if (
    asset.sha256 !== sha256 ||
    asset.mimeType !== mimeType ||
    Number(asset.size) !== byteSize
  )
    throw documentFailure(
      "The stored document does not match the uploaded content",
      409,
    );
  if (
    [asset.expiresAt, asset.rightsExpiry].some(
      (v) => v && new Date(v) <= now,
    ) ||
    ["restricted", "expired"].includes(String(asset.rightsStatus).toLowerCase())
  )
    throw documentFailure("Document rights do not allow its use", 403);
  if (asset.assetScan?.tenantId !== tenantId)
    throw documentFailure("Document scan ownership is unavailable", 409);
  if (["INFECTED", "REJECTED", "MALICIOUS"].includes(asset.assetScan.status))
    throw documentFailure("The document did not pass its malware scan", 422);
  if (clean && asset.assetScan.status !== "CLEAN")
    throw documentFailure("The document malware scan is still pending", 409);
  return asset;
}
export function createOnboardingDamClient(
  { tenantId, checklistId },
  {
    fetchImpl = globalThis.fetch,
    env = process.env,
    sign = signServiceJwtEdDSA,
  } = {},
) {
  if (
    !UUID.test(tenantId || "") ||
    !Number.isSafeInteger(checklistId) ||
    checklistId <= 0
  )
    throw documentFailure("Verified document ownership required", 401);
  let base;
  try {
    base = new URL(env.DAM_SERVICE_URL);
  } catch {
    throw documentFailure("Document storage is unavailable", 503);
  }
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw documentFailure("Document storage configuration is invalid", 503);
  const endpoint = (path) =>
    path.startsWith("/v1/")
      ? new URL(path, base).href
      : base.href.replace(/\/$/, "") + path;
  const uploadHosts = new Set(
    String(env.HR_DAM_UPLOAD_HOSTS || env.HR_DAM_DOWNLOAD_HOSTS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  function uploadUrl(value) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !uploadHosts.has(url.hostname.toLowerCase())
    )
      throw documentFailure(
        "Document storage upload destination is not trusted",
        503,
      );
    return url.href;
  }
  const headers = () => {
    const token = sign({
      tenantId,
      tid: tenantId,
      parentType: "OTHER",
      parentId: "hr-onboarding:" + checklistId,
      purpose: "onboarding-document",
      accessStrategy: "INHERITED",
      capabilityVerified: true,
      capabilityExpiresAt: new Date(Date.now() + 60000).toISOString(),
      operations: ["VIEW_METADATA", "VIEW_CONTENT", "DOWNLOAD"],
    });
    if (!token)
      throw documentFailure(
        "Document storage credentials are unavailable",
        503,
      );
    return {
      "X-Service-Authorization": "Bearer " + token,
      "X-Tenant-Id": tenantId,
    };
  };
  async function bounded(response, limit) {
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw documentFailure("Document storage response exceeds its limit", 503);
    }
    const parts = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > limit)
        throw documentFailure(
          "Document storage response exceeds its limit",
          503,
        );
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
  }
  async function json(path, options = {}) {
    try {
      const r = await fetchImpl(endpoint(path), {
        ...options,
        headers: { ...headers(), ...options.headers },
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(30000),
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw documentFailure("Document storage request failed", 503);
      }
      const parsed = JSON.parse(
        (await bounded(r, 1024 * 1024)).toString("utf8"),
      );
      return parsed;
    } catch (e) {
      if (/^HR-/.test(e.code || "")) throw e;
      throw documentFailure("Document storage is temporarily unavailable", 503);
    }
  }
  return Object.freeze({
    async upload({ bytes, mimeType, externalId }) {
      if (
        !Buffer.isBuffer(bytes) ||
        !bytes.length ||
        bytes.length > 16 * 1024 * 1024 ||
        ![PDF, DOCX].includes(mimeType) ||
        typeof externalId !== "string" ||
        !externalId.length ||
        externalId.length > 256
      )
        throw documentFailure("Invalid onboarding upload");
      if (!uploadHosts.size)
        throw documentFailure(
          "Document storage upload hosts are not configured",
          503,
        );
      const session = (
        await json("/v1/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: mimeType === PDF ? "onboarding.pdf" : "onboarding.docx",
            size: bytes.length,
            mime: mimeType,
            sha256: documentHash(bytes),
            accessStrategy: "INHERITED",
          }),
        })
      )?.data;
      if (
        !UUID.test(session?.sessionId || "") ||
        !Number.isSafeInteger(session.partSize) ||
        session.partSize <= 0 ||
        !Array.isArray(session.parts) ||
        session.parts.length !== Math.ceil(bytes.length / session.partSize)
      )
        throw documentFailure(
          "Document storage returned an invalid upload session",
          503,
        );
      const etags = [];
      let completing = false;
      try {
        // Validate every URL before the first byte leaves HR; never forward its service JWT.
        const parts = session.parts.map((part, index) => {
          if (part.partNumber !== index + 1)
            throw documentFailure("Invalid upload part order", 503);
          return { ...part, url: uploadUrl(part.url) };
        });
        for (const part of parts) {
          const start = (part.partNumber - 1) * session.partSize;
          const response = await fetchImpl(part.url, {
            method: "PUT",
            body: bytes.subarray(
              start,
              Math.min(start + session.partSize, bytes.length),
            ),
            redirect: "manual",
            signal: globalThis.AbortSignal.timeout(30000),
          });
          const etag = response.headers.get("etag");
          await response.body?.cancel();
          if (!response.ok || !etag || etag.length > 256)
            throw documentFailure("Document part could not be stored", 503);
          etags.push({ partNumber: part.partNumber, etag });
        }
        completing = true;
        const raw = await json(
          "/v1/uploads/" + session.sessionId + "/complete",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": externalId,
            },
            body: JSON.stringify({ etags }),
          },
        );
        const id = Number(raw?.data?.asset?.id);
        if (!Number.isSafeInteger(id) || id <= 0)
          throw documentFailure(
            "Document storage did not return an asset identity",
            503,
          );
        return id;
      } catch (error) {
        // Completion may have committed before a timeout. DAM deduplicates retries by
        // tenant + inherited checklist + content hash; never erase an uncertain commit.
        if (!completing)
          await json("/v1/uploads/" + session.sessionId, {
            method: "DELETE",
          }).catch(() => {});
        if (/^HR-/.test(error.code || "")) throw error;
        throw documentFailure(
          "Document storage is temporarily unavailable",
          503,
        );
      }
    },
    async metadata(mediaId) {
      if (!Number.isSafeInteger(mediaId) || mediaId <= 0)
        throw documentFailure("Invalid document identity");
      const raw = await json("/assets/" + mediaId);
      return raw?.data ?? raw?.media ?? raw;
    },
    async download(mediaId, { sha256, mimeType, signed = false } = {}) {
      if (!Number.isSafeInteger(mediaId) || mediaId <= 0)
        throw documentFailure("Invalid document identity");
      const allowed = new Set(
        String(env.HR_DAM_DOWNLOAD_HOSTS || "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      );
      try {
        const raw = await json("/assets/" + mediaId);
        const asset = raw?.data ?? raw?.media ?? raw;
        verifyOnboardingAsset(asset, {
          tenantId,
          checklistId,
          mediaId,
          sha256,
          mimeType,
          byteSize: Number(asset?.size),
        });
        const signedUrl = new URL(asset.url);
        if (
          signedUrl.protocol !== "https:" ||
          signedUrl.username ||
          signedUrl.password ||
          signedUrl.hash ||
          (signedUrl.port && signedUrl.port !== "443") ||
          !allowed.has(signedUrl.hostname.toLowerCase())
        )
          throw Error("storage-url");
        // Metadata signs the asset's authoritative bucket. The legacy video-stream
        // route forces a different bucket and cannot serve these multipart assets.
        let url = signedUrl.href;
        let response = await fetchImpl(url, {
          redirect: "manual",
          signal: globalThis.AbortSignal.timeout(15000),
        });
        for (
          let n = 0;
          [301, 302, 303, 307, 308].includes(response.status);
          n++
        ) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (n >= 2 || !location) throw Error("redirect");
          const next = new URL(location, url);
          if (
            next.protocol !== "https:" ||
            next.username ||
            next.password ||
            next.hash ||
            (next.port && next.port !== "443") ||
            !allowed.has(next.hostname.toLowerCase())
          )
            throw Error("redirect");
          url = next.href;
          response = await fetchImpl(url, {
            redirect: "manual",
            signal: globalThis.AbortSignal.timeout(15000),
          });
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw Error("status");
        }
        const bytes = await bounded(
          response,
          signed ? 16 * 1024 * 1024 : ONBOARDING_DOCUMENT_LIMIT,
        );
        if (
          inspectOnboardingDocument(bytes, { signed }) !== mimeType ||
          documentHash(bytes) !== sha256
        )
          throw documentFailure("The stored document content has changed", 409);
        return bytes;
      } catch (e) {
        if (/^HR-/.test(e.code || "")) throw e;
        throw documentFailure("Document could not be downloaded securely", 503);
      }
    },
  });
}
