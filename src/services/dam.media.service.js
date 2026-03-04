import axios from "axios";
import FormData from "form-data";

const DAM_BASE_URL = process.env.DAM_SERVICE_URL || "http://localhost:3002/api";
const DAM_TIMEOUT = parseInt(process.env.DAM_SERVICE_TIMEOUT || "1000000", 10);

const damApi = axios.create({
  baseURL: DAM_BASE_URL,
  timeout: DAM_TIMEOUT,
});

export async function damRequest(endpoint, method = "GET", body = {}, headers = {}) {
  try {
    const response = await damApi.request({
      url: endpoint.startsWith("/") ? endpoint : `/${endpoint}`,
      method: method.toUpperCase(),
      data: ["POST", "PUT", "PATCH"].includes(method.toUpperCase()) ? body : undefined,
      headers,
    });
    return response.data;
  } catch (error) {
    console.error(`[DAM] ${method} ${endpoint} failed:`, error.response?.data || error.message);
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

export async function uploadFileToDAM(file, type = "avatar") {
  try {
    const formData = new FormData();
    formData.append("type", type);
    formData.append("files", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    formData.append("source", "HR-TruSoft");
    formData.append("externalId", 123);

    const uploadResponse = await damRequest(
      "/assets/upload",
      "POST",
      formData,
      formData.getHeaders()
    );

    return uploadResponse?.items || [];
  } catch (err) {
    console.error("[DAM] Upload failed:", err.response?.data || err.message);
    return [];
  }
}
