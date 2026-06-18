import axios from "axios";
import FormData from "form-data";
import logger from "../lib/logger.js";
import { signServiceJwt } from "../lib/serviceJwt.js";

const DAM_BASE_URL = process.env.DAM_SERVICE_URL || "http://localhost:3002/api";
const DAM_TIMEOUT = parseInt(process.env.DAM_SERVICE_TIMEOUT || "1000000", 10);

const damApi = axios.create({
  baseURL: DAM_BASE_URL,
  timeout: DAM_TIMEOUT,
});

const withInternalSecret = (headers = {}) => {
    const merged = {
        ...headers,
        "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
    };
    const token = signServiceJwt();
    if (token) {
        merged["X-Service-Authorization"] = `Bearer ${token}`;
    }
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
    logger.error({
      err,
      responseData: err.response?.data,
    }, "DAM upload failed");
    return [];
  }
}

