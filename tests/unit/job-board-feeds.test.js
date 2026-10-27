import { beforeEach, afterEach, describe, it, expect } from "@jest/globals";
import {
  boardReference,
  boardJobUrl,
  jobBoardConfig,
  managedBoardPlacements,
  issueBoardReceipt,
  readBoardReceipt,
  publicJobDescription,
  renderJobBoardFeed,
  validateBoardJob,
} from "../../src/lib/job-board-feeds.js";
const tenantId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const config = {
  companyName: "Fictional employer",
  sourceName: "Fictional group",
  publisher: "Fictional ATS",
  publisherUrl: "https://ats.example.invalid",
  careersOrigin: "https://www.example.invalid",
  locations: { Karachi: { city: "Karachi", state: "Sindh", country: "PK" } },
  INDEED: { enabled: true, accountEmail: "indeed@example.invalid" },
  LINKEDIN: { enabled: true, accountEmail: "poster@example.invalid", companyId: "123" },
};
const job = {
  id: 9,
  title: "Engineer",
  location: "Karachi",
  employmentType: "FULL_TIME",
  jobContent: {
    summary:
      "A published role with detailed responsibilities, requirements, benefits and application steps for every applicant.",
    responsibilities: ["Build useful software"],
    requirements: ["Read the published role"],
    benefits: ["Paid leave"],
    hiringProcess: ["Structured interview"],
    privateBudget: "PRIVATE_ONLY",
  },
  closesAt: "2026-12-01T00:00:00Z",
};
const posting = (channel) => ({
  id: 19,
  channel,
  channelRef: boardReference(tenantId, 9, channel),
  postedAt: "2026-10-01T00:00:00Z",
});
const feed = (channel = "INDEED", overrides = {}) =>
  renderJobBoardFeed({
    tenantId,
    config,
    channel,
    jobs: [{ job, posting: posting(channel) }],
    ...overrides,
  });
let saved;
beforeEach(() => {
  saved = { ...process.env };
  process.env.HR_RECRUITMENT_JOB_BOARDS_ENABLED = "true";
  process.env.HR_RECRUITMENT_JOB_BOARDS = JSON.stringify({ [tenantId]: config });
  process.env.HR_PORTAL_HOSTS = "www.example.invalid=" + tenantId;
  process.env.HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY = Buffer.alloc(32, 83).toString("base64");
});
afterEach(() => {
  process.env = saved;
});
describe("company-approved job-board feeds", () => {
  it("is disabled until explicitly enabled and returns no other company configuration", () => {
    expect(jobBoardConfig(other)).toBeNull();
    delete process.env.HR_RECRUITMENT_JOB_BOARDS_ENABLED;
    expect(jobBoardConfig(tenantId)).toBeNull();
  });
  it("requires a unique approved host binding", () => {
    process.env.HR_PORTAL_HOSTS += ",www.example.invalid=" + other;
    expect(() => jobBoardConfig(tenantId)).toThrow();
  });
  it("rejects guessed account identity, insecure URLs, and unapproved provider settings", () => {
    for (const change of [
      { INDEED: { enabled: true } },
      { careersOrigin: "http://www.example.invalid" },
      { careersOrigin: "https://[" },
      { publisherUrl: "https://[" },
      { locations: { Karachi: { city: "Karachi\u0000", state: "Sindh", country: "PK" } } },
      {
        LINKEDIN: {
          enabled: true,
          accountEmail: "poster@example.invalid",
          companyId: "company-name",
        },
      },
      { careersOrigin: "https://www.example.invalid@evil.invalid" },
    ]) {
      process.env.HR_RECRUITMENT_JOB_BOARDS = JSON.stringify({
        [tenantId]: { ...config, ...change },
      });
      expect(() => jobBoardConfig(tenantId)).toThrow();
    }
  });
  it("automatically includes Indeed when its opted-in employer publishes a public role", () => {
    const result = managedBoardPlacements({
      tenantId,
      requisitionId: 9,
      postingChannels: ["CAREER_SITE"],
    });
    expect(result.map((item) => item.channel)).toEqual(["CAREER_SITE", "INDEED"]);
    expect(result[1].channelRef).toBe(boardReference(tenantId, 9, "INDEED"));
  });
  it("keeps unconfigured manual channels and their URL requirement", () => {
    process.env.HR_RECRUITMENT_JOB_BOARDS = "{}";
    expect(() =>
      managedBoardPlacements({ tenantId, requisitionId: 9, postingChannels: ["LINKEDIN"] }),
    ).toThrow();
  });
  it("never guesses a location or publishes an incomplete LinkedIn description", () => {
    expect(() => validateBoardJob(config, { ...job, location: "Lahore" }, "INDEED")).toThrow();
    expect(() =>
      validateBoardJob(config, { ...job, jobContent: { summary: "Too short" } }, "LINKEDIN"),
    ).toThrow();
  });
  it("uses stable tenant- and channel-specific IDs within the provider limit", () => {
    const ref = boardReference(tenantId, 9, "INDEED");
    expect(ref.length).toBeLessThanOrEqual(40);
    expect(ref).toBe(boardReference(tenantId, 9, "INDEED"));
    expect(ref).not.toBe(boardReference(other, 9, "INDEED"));
    expect(ref).not.toBe(boardReference(tenantId, 9, "LINKEDIN"));
  });
  it("binds receipts to the company, job and posting without granting candidate access", () => {
    const receipt = issueBoardReceipt({ tenantId, requisitionId: 9, posting: posting("INDEED") });
    expect(readBoardReceipt(receipt, { tenantId, requisitionId: 9 })).toMatchObject({
      postingId: 19,
      channel: "INDEED",
    });
    expect(readBoardReceipt(receipt, { tenantId: other, requisitionId: 9 })).toBeNull();
    expect(readBoardReceipt(receipt, { tenantId, requisitionId: 10 })).toBeNull();
    expect(readBoardReceipt("x" + receipt, { tenantId, requisitionId: 9 })).toBeNull();
    expect(readBoardReceipt("x".repeat(1025), { tenantId, requisitionId: 9 })).toBeNull();
  });
  it("fails feed generation if its signing key is absent", () => {
    delete process.env.HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY;
    expect(() => feed()).toThrow();
  });
  it("produces provider-specific direct job URLs without a redirect target supplied by the caller", () => {
    for (const channel of ["INDEED", "LINKEDIN"]) {
      const url = new URL(boardJobUrl(config, 9, channel, "signed.receipt"));
      expect(url.origin).toBe(config.careersOrigin);
      expect(url.pathname).toBe("/jobs/9");
      expect(url.searchParams.get("sourceReceipt")).toBe("signed.receipt");
    }
  });
  it("contains only the website's published description sections in their display order", () => {
    const description = publicJobDescription(job);
    expect(description).not.toContain("PRIVATE_ONLY");
    expect(description.indexOf("Responsibilities")).toBeLessThan(
      description.indexOf("What you bring"),
    );
    expect(description.indexOf("Benefits")).toBeLessThan(description.indexOf("Hiring process"));
  });
  it("escapes authored markup and splits CDATA terminators without creating XML elements", () => {
    const xml = feed("INDEED", {
      jobs: [{ job: { ...job, title: "Role ]]> <script>" }, posting: posting("INDEED") }],
    });
    expect(xml).toContain("Role ]]]]><![CDATA[> <script>");
    expect(
      publicJobDescription({ ...job, jobContent: { summary: "<script>alert(1)</script> & text" } }),
    ).toContain("&lt;script&gt;");
  });
  it("rejects invalid XML control characters instead of silently altering the public content", () => {
    expect(() => validateBoardJob(config, { ...job, title: "Invalid\u0000" }, "INDEED")).toThrow();
    expect(() =>
      feed("INDEED", {
        jobs: [{ job: { ...job, title: "Invalid\u0000" }, posting: posting("INDEED") }],
      }),
    ).toThrow();
  });
  it("contains required Indeed identities and signed source tracking, excluding candidate data", () => {
    const xml = feed();
    for (const name of [
      "publisher",
      "publisherurl",
      "referencenumber",
      "requisitionid",
      "date",
      "sourcename",
      "email",
      "url",
      "city",
      "state",
      "country",
    ])
      expect(xml).toContain("<" + name + ">");
    expect(xml).toContain("source=Indeed");
    expect(xml).toContain("sourceReceipt=");
    expect(xml).not.toContain("PRIVATE_ONLY");
  });
  it("contains LinkedIn company, account and stable job identity with exact job count", () => {
    const xml = feed("LINKEDIN");
    for (const name of ["partnerJobId", "companyId", "posterEmail", "applyUrl", "expectedJobCount"])
      expect(xml).toContain("<" + name + ">");
    expect(xml).toContain("<expectedJobCount><![CDATA[1]]>");
  });
  it("rejects duplicate jobs and stale manual references", () => {
    const item = { job, posting: posting("INDEED") };
    expect(() => feed("INDEED", { jobs: [item, item] })).toThrow();
    expect(() =>
      feed("INDEED", { jobs: [{ job, posting: { ...item.posting, channelRef: "legacy" } }] }),
    ).toThrow();
  });
  it("permits an intentionally empty feed for a fully closed inventory", () => {
    expect(feed("INDEED", { jobs: [] })).not.toContain("<job>");
  });
});
