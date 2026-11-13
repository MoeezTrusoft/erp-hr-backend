// src/services/candidateResume.service.js — upload a candidate resume file to
// DAM and set Candidate.resumeMediaId to the real asset id. Tenant-scoped.
import prisma from "../lib/prisma.js";
import { fileFromBase64 } from "./hrContract.service.js";
import { uploadFileToDAM, normalizeDamAssetResponse } from "./dam.media.service.js";

export async function uploadCandidateResume({ candidateId, fileBase64, fileName, tenantId }) {
  const id = Number(candidateId);
  if (!Number.isFinite(id)) throw Object.assign(new Error("candidateId is required"), { status: 400 });

  const candidate = await prisma.candidate.findFirst({ where: { id, tenantId: tenantId ?? null } });
  if (!candidate) throw Object.assign(new Error("Candidate not found"), { status: 404 });

  const file = fileFromBase64(fileBase64, fileName || `resume-${id}.pdf`);
  if (!file) throw Object.assign(new Error("A resume file (fileBase64) is required"), { status: 400 });

  const uploaded = await uploadFileToDAM(file, "document");
  const asset = normalizeDamAssetResponse(uploaded);
  if (!asset?.id) throw new Error("Failed to upload resume to DAM");
  const mediaId = Number(asset.id);

  await prisma.candidate.update({ where: { id }, data: { resumeMediaId: mediaId } });
  return { candidateId: id, resumeMediaId: mediaId, fileName: file.originalname, mimeType: file.mimetype };
}
