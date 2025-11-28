import axios from "axios";
import FormData from "form-data";

const DAM_BASE_URL = process.env.DAM_SERVICE_URL || "http://localhost:3002/api";
const DAM_TIMEOUT = parseInt(process.env.DAM_SERVICE_TIMEOUT || "1000000", 1000);

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

// New helper: upload file to DAM
export async function uploadFileToDAM(file, type = "avatar") {
  try {
    const formData = new FormData();
    formData.append("type", type);
    formData.append("files", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    formData.append("source", "HR-TruSoft"); // REQUIRED
    formData.append("externalId", 123)

    // ✅ Send to DAM
    const uploadResponse = await damRequest(
      "/assets/upload",
      "POST",
      formData,
      formData.getHeaders()
    );

    console.log(uploadResponse, "upload response");
    

    // ✅ Correct return value
    return uploadResponse?.items;
  } catch (err) {
    console.error("[DAM] Upload failed:", err.response?.data || err.message);
    return null;
  }
}