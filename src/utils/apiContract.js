import { randomUUID } from "crypto";
import { GENERIC_INTERNAL } from "../constants/errorCodes.js";

export const attachRequestId = (req, res, next) => {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
};

export const sendContractSuccess = (
  res,
  data = {},
  message = "Success",
  statusCode = 200,
  meta = {}
) =>
  res.status(statusCode).json({
    success: true,
    message,
    data,
    meta,
    requestId: res.req?.requestId,
  });

export const sendContractError = (
  res,
  error,
  statusCode = 500,
  code = "SERVER_ERROR"
) => {
  // ERR-3: a 5xx never emits the raw error.message (could be Prisma/RLS/internal
  // detail). Genericize the client-facing message + code for server errors; keep
  // client-safe messages for 4xx. The full error is logged by the caller.
  const isServer = statusCode >= 500;
  const message = isServer
    ? GENERIC_INTERNAL.message
    : (error?.message || "Something went wrong");
  const safeCode = isServer ? GENERIC_INTERNAL.code : code;

  return res.status(statusCode).json({
    success: false,
    message,
    errors: [{ code: safeCode, message }],
    requestId: res.req?.requestId,
  });
};

export const parseListQuery = (query, defaults = {}) => {
  const page = Math.max(Number(query.page || defaults.page || 1), 1);
  const pageSize = Math.min(
    Math.max(Number(query.pageSize || defaults.pageSize || 20), 1),
    defaults.maxPageSize || 100
  );

  return {
    q: query.q || query.search || "",
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    sort: query.sort || defaults.sort || "createdAt",
    order: query.order === "asc" ? "asc" : "desc",
  };
};

export const buildListPayload = ({ items, page, pageSize, total, sort, order, filters = {} }) => ({
  items,
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
  sort,
  order,
  filters,
});

export const toInt = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
