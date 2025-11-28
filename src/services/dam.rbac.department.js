import axios from "axios";

const HR_BASE_URL = process.env.HR_SERVICE_URL || "http://localhost:3001/api";
const HR_TIMEOUT = parseInt(process.env.HR_SERVICE_TIMEOUT || "10000", 10);

const hrApi = axios.create({
    baseURL: HR_BASE_URL,
    timeout: HR_TIMEOUT,
});

export async function hrRequest(endpoint, method = "GET", body = {}, headers = {}) {
    try {
        const response = await hrApi.request({
            url: endpoint.startsWith("/") ? endpoint : `/${endpoint}`,
            method: method.toUpperCase(),
            data: ["POST", "PUT", "PATCH"].includes(method.toUpperCase()) ? body : undefined,
            headers,
        });

        return response.data;
    } catch (error) {
        console.error(
            `[HR] ${method} ${endpoint} failed:`,
            error.response?.data || error.message
        );
        return null;
    }
}
