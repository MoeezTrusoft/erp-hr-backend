import { createHash, randomUUID } from "node:crypto";
import {
  damRequest,
  normalizeDamAssetResponse,
  uploadFileToDAM,
  downloadAssessmentImage,
} from "../dam.media.service.js";
import { run, fail } from "./base.js";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const permission = (name) => "hr.recruitment.assessment." + name;
export function inspectImage(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    !buffer.length ||
    buffer.length > MAX_IMAGE_BYTES
  )
    fail("Choose an image up to 2 MB");
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  fail("Choose a PNG, JPEG, GIF or WebP image");
}
export function validateImageAsset(asset, tenantId, now = new Date()) {
  if (!asset || asset.tenantId !== tenantId || asset.isDeleted)
    fail("Image not found in this company", 404);
  if (
    asset.assetScan?.tenantId !== tenantId ||
    asset.assetScan?.status !== "CLEAN"
  )
    fail("The image has not passed its malware scan", 409);
  if (
    [asset.expiresAt, asset.rightsExpiry].some(
      (v) => v && new Date(v) <= now,
    ) ||
    ["restricted", "expired"].includes(String(asset.rightsStatus).toLowerCase())
  )
    fail("Image rights do not allow its use", 403);
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256 || ""))
    fail("Image checksum unavailable", 409);
  if (
    !Number.isSafeInteger(Number(asset.size)) ||
    Number(asset.size) < 1 ||
    Number(asset.size) > MAX_IMAGE_BYTES
  )
    fail("Choose an image up to 2 MB");
  return asset;
}
async function metadata(mediaId, env) {
  if (!/^[1-9]\d*$/.test(String(mediaId))) fail("Choose a valid library image");
  return validateImageAsset(
    normalizeDamAssetResponse(await damRequest("/assets/" + mediaId)),
    env.tenantId,
    env.now,
  );
}
async function verifiedBytes(asset, expectedHash = asset.sha256) {
  const media = await downloadAssessmentImage(String(asset.id));
  const mimeType = inspectImage(media.buffer);
  if (
    mimeType !== media.mimeType ||
    mimeType !== asset.mimeType ||
    hash(media.buffer) !== expectedHash.toLowerCase()
  )
    fail(
      "The image content has changed; select and review a new image version",
      409,
    );
  return { ...media, mimeType };
}
export async function registerImage(tx, env, mediaId) {
  const asset = await metadata(mediaId, env);
  const media = await verifiedBytes(asset);
  const rows = await tx.$queryRaw`INSERT INTO "CandidateAssessmentImage"
    ("tenantId", "mediaId", sha256, "mimeType", "fileName", "byteSize", "createdById")
    VALUES (${env.tenantId}::uuid, ${String(asset.id)}, ${hash(media.buffer)}, ${media.mimeType}, ${String(asset.filename || "Assessment image").slice(0, 200)}, ${media.buffer.length}, ${env.who.id})
    ON CONFLICT ("tenantId", "mediaId", sha256) DO UPDATE SET "mediaId"=EXCLUDED."mediaId"
    RETURNING id, "mediaId", sha256, "mimeType", "fileName", "byteSize"`;
  return rows[0];
}
export const imageUpload = (input) =>
  run(permission("create"), async (tx, env) => {
    if (
      typeof input.fileBase64 !== "string" ||
      input.fileBase64.length > 2796204
    )
      fail("Invalid image upload");
    const buffer = Buffer.from(input.fileBase64, "base64");
    if (buffer.toString("base64") !== input.fileBase64)
      fail("Invalid image upload");
    const mimeType = inspectImage(buffer);
    const assets = await uploadFileToDAM(
      { buffer, mimetype: mimeType, originalname: input.fileName },
      "image",
      { externalId: "assessment-image-" + randomUUID() },
    );
    if (!assets[0]?.id) fail("Image upload is temporarily unavailable", 503);
    return registerImage(tx, env, String(assets[0].id));
  });
export const imageRegister = (input) =>
  run(permission("create"), (tx, env) => registerImage(tx, env, input.mediaId));
export const imagesList = (input) =>
  run(permission("read"), async (tx, env) => {
    const rows =
      await tx.$queryRaw`SELECT id, "mediaId", sha256, "mimeType", "fileName", "byteSize" FROM "CandidateAssessmentImage"
    WHERE "tenantId"=${env.tenantId}::uuid AND id>${input.cursor ?? 0}
    AND "fileName" ILIKE ${"%" + (input.q || "").replace(/[%_]/g, "").replaceAll(String.fromCharCode(92), "") + "%"}
    ORDER BY id LIMIT ${(input.limit ?? 20) + 1}`;
    const items = rows.slice(0, input.limit ?? 20);
    return {
      items,
      nextCursor: rows.length > items.length ? items.at(-1).id : null,
    };
  });
export const imagePreview = (input) =>
  run(permission("read"), async (tx, env) => {
    const rows =
      await tx.$queryRaw`SELECT * FROM "CandidateAssessmentImage" WHERE "tenantId"=${env.tenantId}::uuid AND id=${input.id}`;
    if (!rows[0]) fail("Image not found", 404);
    const asset = await metadata(rows[0].mediaId, env);
    const media = await verifiedBytes(asset, rows[0].sha256);
    return {
      mimeType: media.mimeType,
      base64: media.buffer.toString("base64"),
    };
  });
export async function pinItemImage(tx, env, item) {
  if (!item.mediaId) {
    await tx.$executeRaw`DELETE FROM "CandidateTestItemImage" WHERE "tenantId"=${env.tenantId}::uuid AND "itemId"=${item.id}`;
    return;
  }
  const image = await registerImage(tx, env, item.mediaId);
  await tx.$executeRaw`INSERT INTO "CandidateTestItemImage" ("tenantId", "itemId", "imageId") VALUES (${env.tenantId}::uuid, ${item.id}, ${image.id})
    ON CONFLICT ("itemId") DO UPDATE SET "imageId"=EXCLUDED."imageId"`;
}
export async function itemImageReference(
  tx,
  tenantId,
  itemId,
  required = true,
) {
  const rows =
    await tx.$queryRaw`SELECT i.id, i."mediaId", i.sha256, i."fileName", i."mimeType", i."byteSize" FROM "CandidateTestItemImage" p
    JOIN "CandidateAssessmentImage" i ON i.id=p."imageId" AND i."tenantId"=p."tenantId"
    WHERE p."tenantId"=${tenantId}::uuid AND p."itemId"=${itemId}`;
  if (!rows[0] && required)
    fail("Image needs author verification before this test can be used", 409);
  return rows[0] ?? null;
}
export async function downloadPinnedImage(reference, tenantId) {
  const asset = await metadata(reference.mediaId, {
    tenantId,
    now: new Date(),
  });
  return verifiedBytes(asset, reference.sha256);
}
