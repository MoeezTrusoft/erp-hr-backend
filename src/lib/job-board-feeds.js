import { JobBoardSettings } from "@trusoft/contracts/recruitment-policy";
import crypto from "node:crypto";
import { z } from "zod";
import { isRecruitmentFlagEnabled } from "./recruitmentFlags.js";
import { normalizeChannelList } from "./requisitionPublication.js";

export const JOB_BOARD_CHANNELS = Object.freeze(["INDEED", "LINKEDIN"]);
export const jobBoardUnavailable = () =>
  Object.assign(new Error("Job-board publication is temporarily unavailable"), {
    status: 503,
    code: "HR-5310",
  });
const parseUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};
const text = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    // eslint-disable-next-line no-control-regex -- XML 1.0 rejects these control code points.
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF\uD800-\uDFFF]/u.test(value),
    "Use valid display text",
  );
const Origin = z.url().refine((value) => {
  const url = parseUrl(value);
  return (
    !!url &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    !url.port
  );
});
const Location = z
  .object({
    city: text,
    state: text,
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();
const Provider = z.object({ enabled: z.literal(true), accountEmail: z.email().max(254) }).strict();
const Company = z
  .object({
    companyName: text,
    sourceName: text,
    publisher: text,
    publisherUrl: z.url().refine((v) => {
      const u = parseUrl(v);
      return !!u && u.protocol === "https:" && !u.username && !u.password;
    }),
    careersOrigin: Origin,
    locations: z.record(z.string().min(1).max(500), Location),
    INDEED: Provider.optional(),
    LINKEDIN: Provider.extend({ companyId: z.string().regex(/^[1-9]\d{0,19}$/) })
      .strict()
      .optional(),
  })
  .strict();
export function storedBoardConfig(settings) {
  if (settings == null) return null;
  const value = JobBoardSettings.parse(settings);
  if (!value.INDEED.enabled && !value.LINKEDIN.enabled) return null;
  return Company.parse({
    companyName: value.companyName,
    sourceName: value.sourceName,
    publisher: value.publisher,
    publisherUrl: value.publisherUrl,
    careersOrigin: value.careersOrigin,
    locations: Object.fromEntries(value.locations.map(({ name, ...location }) => [name, location])),
    ...(value.INDEED.enabled ? { INDEED: value.INDEED } : {}),
    ...(value.LINKEDIN.enabled ? { LINKEDIN: value.LINKEDIN } : {}),
  });
}
function environmentConfig(tenantId) {
  const raw = process.env.HR_RECRUITMENT_JOB_BOARDS || "{}";
  if (Buffer.byteLength(raw) > 262144) throw jobBoardUnavailable();
  return z.record(z.uuid(), Company).parse(JSON.parse(raw))[tenantId] || null;
}
export function approvedBoardOrigins(tenantId) {
  const mappings = (process.env.HR_PORTAL_HOSTS || "").split(",").map((pair) =>
    pair
      .trim()
      .split("=")
      .map((p) => p.trim()),
  );
  return mappings
    .filter(
      ([host, company]) =>
        company === tenantId &&
        host &&
        mappings.filter(([h]) => h?.toLowerCase() === host.toLowerCase()).length === 1,
    )
    .map(([host]) => "https://" + host.toLowerCase())
    .filter((url) => Origin.safeParse(url).success);
}
export function validateBoardBinding(tenantId, config) {
  if (!config) return null;
  signingKey();
  const origin = new URL(config.careersOrigin).origin;
  if (!approvedBoardOrigins(tenantId).includes(origin)) throw jobBoardUnavailable();
  if (config.LINKEDIN && !new URL(origin).hostname.startsWith("www.")) throw jobBoardUnavailable();
  return { ...config, careersOrigin: origin };
}
export function jobBoardConfig(tenantId, settings = undefined) {
  if (!isRecruitmentFlagEnabled("jobBoards")) return null;
  try {
    return validateBoardBinding(
      tenantId,
      settings === undefined ? environmentConfig(tenantId) : storedBoardConfig(settings),
    );
  } catch {
    throw jobBoardUnavailable();
  }
}
export async function readJobBoardConfig(db, tenantId) {
  if (!isRecruitmentFlagEnabled("jobBoards")) return null;
  const row = await db.recruitmentSettings.findUnique({
    where: { tenantId },
    select: { policy: true },
  });
  return jobBoardConfig(tenantId, row?.policy?.jobBoards);
}
export function jobBoardStatus(tenantId, settings) {
  const approvedOrigins = approvedBoardOrigins(tenantId);
  let config = null,
    signingReady = false;
  try {
    config = settings === undefined ? environmentConfig(tenantId) : storedBoardConfig(settings);
  } catch {
    /* Draft or invalid deployment configuration is never activated. */
  }
  try {
    signingKey();
    signingReady = true;
  } catch {
    /* Expose readiness only, never key material. */
  }
  const origin = config?.careersOrigin || settings?.careersOrigin || "";
  const originApproved = !!origin && approvedOrigins.includes(parseUrl(origin)?.origin);
  const deploymentEnabled = isRecruitmentFlagEnabled("jobBoards"),
    portalEnabled = isRecruitmentFlagEnabled("portal");
  const activeProviders =
    deploymentEnabled && portalEnabled && signingReady && originApproved
      ? JOB_BOARD_CHANNELS.filter((channel) => config?.[channel])
      : [];
  return {
    deploymentEnabled,
    portalEnabled,
    signingReady,
    approvedOrigins,
    originApproved,
    usingEnvironment: settings === undefined,
    activeProviders,
    feedUrls: Object.fromEntries(
      JOB_BOARD_CHANNELS.map((channel) => [
        channel,
        originApproved
          ? new URL("/public/job-boards/" + channel.toLowerCase() + ".xml", origin).href
          : null,
      ]),
    ),
  };
}
export function boardReference(tenantId, requisitionId, channel) {
  if (
    !JOB_BOARD_CHANNELS.includes(channel) ||
    !Number.isSafeInteger(requisitionId) ||
    requisitionId < 1
  )
    throw jobBoardUnavailable();
  return (
    "hr-" +
    crypto
      .createHash("sha256")
      .update(tenantId + ":" + requisitionId + ":" + channel)
      .digest("hex")
      .slice(0, 32)
  );
}
export function boardJobUrl(config, id, channel, receipt = null) {
  const url = new URL("/jobs/" + id, config.careersOrigin);
  url.searchParams.set("source", channel === "INDEED" ? "Indeed" : "LinkedIn");
  if (receipt) url.searchParams.set("sourceReceipt", receipt);
  return url.href;
}
export function managedBoardPlacements({
  tenantId,
  requisitionId,
  postingChannels,
  externalUrl,
  channelRef,
  config = jobBoardConfig(tenantId),
}) {
  let raw =
    postingChannels == null || postingChannels === ""
      ? ["CAREER_SITE"]
      : Array.isArray(postingChannels)
        ? [...postingChannels]
        : [postingChannels];
  const channelOf = (entry) =>
    String(typeof entry === "string" ? entry : (entry?.channel ?? entry?.name ?? ""))
      .trim()
      .toUpperCase();
  // Indeed opts the whole employer's public careers inventory in. Publication
  // of a new public role must create its matching Indeed channel in this transaction.
  if (
    config?.INDEED &&
    raw.some((entry) => channelOf(entry) === "CAREER_SITE") &&
    !raw.some((entry) => channelOf(entry) === "INDEED")
  )
    raw.push("INDEED");
  raw = raw.map((entry) => {
    const channel = channelOf(entry);
    if (!JOB_BOARD_CHANNELS.includes(channel) || !config?.[channel]) return entry;
    return {
      channel,
      channelRef: boardReference(tenantId, requisitionId, channel),
      externalUrl: boardJobUrl(config, requisitionId, channel),
    };
  });
  return normalizeChannelList(raw, { externalUrl, channelRef });
}
function signingKey() {
  const raw = process.env.HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY || "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw jobBoardUnavailable();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) throw jobBoardUnavailable();
  return key;
}
export function issueBoardReceipt({ tenantId, requisitionId, posting }) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      tenantId,
      requisitionId,
      postingId: posting.id,
      channel: posting.channel,
      ref: posting.channelRef,
    }),
  ).toString("base64url");
  return (
    payload +
    "." +
    crypto
      .createHmac("sha256", signingKey())
      .update("hr-job-board-v1:" + payload)
      .digest("base64url")
  );
}
const Receipt = z
  .object({
    v: z.literal(1),
    tenantId: z.uuid(),
    requisitionId: z.number().int().positive(),
    postingId: z.number().int().positive(),
    channel: z.enum(JOB_BOARD_CHANNELS),
    ref: z.string().max(40),
  })
  .strict();
export function readBoardReceipt(token, { tenantId, requisitionId }) {
  if (typeof token !== "string" || token.length > 1024 || !/^[\w-]+\.[\w-]{43}$/.test(token))
    return null;
  try {
    const [payload, signature] = token.split(".");
    const expected = crypto
      .createHmac("sha256", signingKey())
      .update("hr-job-board-v1:" + payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      actual.toString("base64url") !== signature ||
      !crypto.timingSafeEqual(actual, expected)
    )
      return null;
    const decoded = Receipt.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (
      decoded.tenantId !== tenantId ||
      decoded.requisitionId !== requisitionId ||
      decoded.ref !== boardReference(tenantId, requisitionId, decoded.channel)
    )
      return null;
    return decoded;
  } catch {
    return null;
  }
}
const xmlCharacters = (value) => {
  const result = String(value);
  if (
    // eslint-disable-next-line no-control-regex -- XML 1.0 rejects these control code points.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/u.test(result) ||
    /[\uD800-\uDFFF]/u.test(result)
  )
    throw jobBoardUnavailable();
  return result;
};
const cdata = (value) =>
  "<![CDATA[" + xmlCharacters(value).replaceAll("]]>", "]]]]><![CDATA[>") + "]]>";
const element = (name, value) => "<" + name + ">" + cdata(value) + "</" + name + ">";
const html = (value) =>
  xmlCharacters(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function publicJobDescription(job) {
  const content = job.jobContent || {};
  if (typeof content.summary !== "string" || !content.summary.trim()) throw jobBoardUnavailable();
  let value = "<p>" + html(content.summary) + "</p>";
  for (const [label, field] of [
    ["Responsibilities", "responsibilities"],
    ["What you bring", "requirements"],
    ["Benefits", "benefits"],
    ["Hiring process", "hiringProcess"],
  ]) {
    const rows = content[field] || [];
    if (!Array.isArray(rows) || rows.some((row) => typeof row !== "string"))
      throw jobBoardUnavailable();
    if (rows.length)
      value +=
        "<p><strong>" +
        label +
        "</strong></p><ul>" +
        rows.map((row) => "<li>" + html(row) + "</li>").join("") +
        "</ul>";
  }
  if (value.length > 131072) throw jobBoardUnavailable();
  return value;
}
export function validateBoardJob(config, job, channel) {
  if (!config?.[channel] || typeof job.title !== "string" || !job.title.trim())
    throw jobBoardUnavailable();
  const location = Object.hasOwn(config.locations, job.location)
    ? config.locations[job.location]
    : null;
  if (!location) throw jobBoardUnavailable();
  xmlCharacters(job.title);
  const description = publicJobDescription(job);
  if (channel === "LINKEDIN" && description.replace(/<[^>]*>/g, "").length < 100)
    throw jobBoardUnavailable();
  return { location, description };
}
export function renderEmptyBoardFeed(settings, channel, now = new Date()) {
  return (
    '<?xml version="1.0" encoding="utf-8"?><source>' +
    (settings?.publisher ? element("publisher", settings.publisher) : "") +
    (settings?.publisherUrl
      ? element(channel === "LINKEDIN" ? "publisherURL" : "publisherurl", settings.publisherUrl)
      : "") +
    (channel === "LINKEDIN"
      ? element("lastBuildDate", now.toUTCString()) + element("expectedJobCount", 0)
      : "") +
    "</source>"
  );
}
export function renderJobBoardFeed({ tenantId, config, channel, jobs, now = new Date() }) {
  if (!JOB_BOARD_CHANNELS.includes(channel) || !config?.[channel] || jobs.length > 10000)
    throw jobBoardUnavailable();
  const seen = new Set();
  let encodedBytes = 0;
  const nodes = jobs.map(({ job, posting }) => {
    if (
      seen.has(job.id) ||
      posting.channel !== channel ||
      posting.channelRef !== boardReference(tenantId, job.id, channel)
    )
      throw jobBoardUnavailable();
    seen.add(job.id);
    const { location, description } = validateBoardJob(config, job, channel);
    encodedBytes += Buffer.byteLength(description) + Buffer.byteLength(job.title) + 8192;
    if (encodedBytes > 16 * 1024 * 1024) throw jobBoardUnavailable();
    const url = boardJobUrl(
      config,
      job.id,
      channel,
      issueBoardReceipt({ tenantId, requisitionId: job.id, posting }),
    );
    const common =
      element("title", job.title) +
      element("company", config.companyName) +
      element("description", description) +
      element("city", location.city) +
      element("state", location.state) +
      element("country", location.country);
    if (channel === "INDEED")
      return (
        "<job>" +
        common +
        element("date", new Date(posting.postedAt).toISOString()) +
        element("referencenumber", posting.channelRef) +
        element("requisitionid", job.id) +
        element("url", url) +
        element("sourcename", config.sourceName) +
        element("email", config.INDEED.accountEmail) +
        (job.employmentType ? element("jobtype", job.employmentType) : "") +
        (job.closesAt
          ? element("expirationdate", new Date(job.closesAt).toISOString().slice(0, 10))
          : "") +
        "</job>"
      );
    return (
      "<job>" +
      common +
      element("partnerJobId", posting.channelRef) +
      element("applyUrl", url) +
      element("companyId", config.LINKEDIN.companyId) +
      element("posterEmail", config.LINKEDIN.accountEmail) +
      element("jobPostingAvailability", "PUBLIC") +
      "</job>"
    );
  });
  const result =
    '<?xml version="1.0" encoding="UTF-8"?><source>' +
    element("publisher", config.publisher) +
    element(channel === "INDEED" ? "publisherurl" : "publisherUrl", config.publisherUrl) +
    (channel === "LINKEDIN"
      ? element("lastBuildDate", now.toUTCString()) + element("expectedJobCount", nodes.length)
      : "") +
    nodes.join("") +
    "</source>";
  if (Buffer.byteLength(result) > 16 * 1024 * 1024) throw jobBoardUnavailable();
  return result;
}
