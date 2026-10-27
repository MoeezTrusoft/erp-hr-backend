import { beforeEach, afterEach, it, expect, jest } from "@jest/globals";
import { JobBoardSettings, RecruitmentPolicy } from "@trusoft/contracts/recruitment-policy";
import {
  jobBoardConfig,
  jobBoardStatus,
  readJobBoardConfig,
  renderEmptyBoardFeed,
  storedBoardConfig,
} from "../../src/lib/job-board-feeds.js";
const tenant = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const configured = () =>
  JobBoardSettings.parse({
    companyName: "Example",
    sourceName: "Example group",
    publisher: "Example ATS",
    publisherUrl: "https://ats.example.invalid",
    careersOrigin: "https://www.example.invalid",
    locations: [{ name: "Karachi", city: "Karachi", state: "Sindh", country: "PK" }],
    INDEED: { enabled: true, accountEmail: "board@example.invalid" },
  });
let env;
beforeEach(() => {
  env = { ...process.env };
  process.env.HR_RECRUITMENT_JOB_BOARDS_ENABLED = "true";
  process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "true";
  process.env.HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY = Buffer.alloc(32, 83).toString("base64");
  process.env.HR_PORTAL_HOSTS = "www.example.invalid=" + tenant;
  delete process.env.HR_RECRUITMENT_JOB_BOARDS;
});
afterEach(() => {
  process.env = env;
});
it("allows disabled drafts without guessed provider identities", () => {
  const s = JobBoardSettings.parse({});
  expect(s.INDEED.enabled).toBe(false);
  expect(storedBoardConfig(s)).toBeNull();
});
it("requires provider-approved email and employer details for activation", () => {
  expect(JobBoardSettings.safeParse({ INDEED: { enabled: true } }).success).toBe(false);
});
it("validates LinkedIn numeric identity and approved www origin", () => {
  const s = configured();
  s.LINKEDIN = { enabled: true, accountEmail: "poster@example.invalid", companyId: "not-an-id" };
  expect(JobBoardSettings.safeParse(s).success).toBe(false);
  s.LINKEDIN.companyId = "123";
  s.careersOrigin = "https://careers.example.invalid";
  expect(JobBoardSettings.safeParse(s).success).toBe(false);
});
it("rejects duplicate location keys and unsafe website forms", () => {
  const s = configured();
  s.locations.push({ ...s.locations[0] });
  expect(JobBoardSettings.safeParse(s).success).toBe(false);
  for (const url of [
    "http://www.example.invalid",
    "https://a@www.example.invalid",
    "https://www.example.invalid/jobs",
    "https://www.example.invalid:444",
  ]) {
    expect(JobBoardSettings.safeParse({ ...configured(), careersOrigin: url }).success).toBe(false);
  }
});
it("does not accept credentials or arbitrary tenant fields", () => {
  expect(JobBoardSettings.safeParse({ ...configured(), tenantId: other }).success).toBe(false);
  expect(
    JobBoardSettings.safeParse({
      ...configured(),
      INDEED: { enabled: true, accountEmail: "a@example.invalid", password: "secret" },
    }).success,
  ).toBe(false);
});
it("keeps legacy policy omission distinct from an explicit disabled override", () => {
  expect(Object.hasOwn(RecruitmentPolicy.parse({}), "jobBoards")).toBe(false);
  expect(RecruitmentPolicy.parse({ jobBoards: null }).jobBoards).toBeNull();
});
it("persisted settings override deployment defaults per company", () => {
  process.env.HR_RECRUITMENT_JOB_BOARDS = JSON.stringify({
    [tenant]: storedBoardConfig(configured()),
  });
  expect(jobBoardConfig(tenant).INDEED).toBeTruthy();
  expect(jobBoardConfig(tenant, JobBoardSettings.parse({}))).toBeNull();
  expect(jobBoardConfig(tenant, null)).toBeNull();
});
it("denies other-company and duplicate host mappings", () => {
  expect(() => jobBoardConfig(other, configured())).toThrow();
  process.env.HR_PORTAL_HOSTS += ",www.example.invalid=" + other;
  expect(() => jobBoardConfig(tenant, configured())).toThrow();
});
it("reads only the requested tenant from persistence", async () => {
  const db = {
    recruitmentSettings: {
      findUnique: jest.fn(async () => ({ policy: { jobBoards: configured() } })),
    },
  };
  expect((await readJobBoardConfig(db, tenant)).INDEED.accountEmail).toBe("board@example.invalid");
  expect(db.recruitmentSettings.findUnique).toHaveBeenCalledWith({
    where: { tenantId: tenant },
    select: { policy: true },
  });
});
it("does not query settings while deployment is disabled", async () => {
  delete process.env.HR_RECRUITMENT_JOB_BOARDS_ENABLED;
  expect(await readJobBoardConfig({}, tenant)).toBeNull();
});
it("reports readiness and feed URLs without account emails or signing material", () => {
  const s = jobBoardStatus(tenant, configured());
  expect(s.activeProviders).toEqual(["INDEED"]);
  expect(s.feedUrls.INDEED).toBe("https://www.example.invalid/public/job-boards/indeed.xml");
  expect(JSON.stringify(s)).not.toContain("board@example.invalid");
  expect(JSON.stringify(s)).not.toContain(process.env.HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY);
});
it("serves an empty inventory when a company disables a provider", () => {
  const xml = renderEmptyBoardFeed({ ...configured(), publisher: "A ]]> B" }, "LINKEDIN");
  expect(xml).not.toContain("<job>");
  expect(xml).toContain("<expectedJobCount><![CDATA[0]]>");
  expect(xml).toContain("]]]]><![CDATA[>");
});

it("returns validation issues for malformed website input, including LinkedIn cross-field checks", () => {
  for (const value of ["not a website", "https://[", "https://", "https://exa mple.invalid"]) {
    for (const key of ["careersOrigin", "publisherUrl"]) {
      const settings = {
        ...configured(),
        [key]: value,
        LINKEDIN: { enabled: true, accountEmail: "poster@example.invalid", companyId: "123" },
      };
      const parsed = JobBoardSettings.safeParse(settings);
      expect(parsed.success).toBe(false);
      expect(parsed.error.issues.some((issue) => issue.path[0] === key)).toBe(true);
    }
  }
});
it("returns policy validation issues for malformed legacy careers base URLs", () => {
  for (const value of ["invalid", "https://[", "https://"]) {
    const parsed = RecruitmentPolicy.safeParse({ careerBaseUrl: value });
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues.some((issue) => issue.path[0] === "careerBaseUrl")).toBe(true);
  }
});
it("rejects invalid XML location text while preserving valid international names", () => {
  for (const key of ["name", "city", "state"]) {
    for (const suffix of ["\u0000", "\ud800", "\ufffe"]) {
      const settings = configured();
      settings.locations[0][key] += suffix;
      expect(JobBoardSettings.safeParse(settings).success).toBe(false);
    }
  }
  const settings = configured();
  settings.locations[0].city = "کراچی 🌍";
  expect(JobBoardSettings.parse(settings).locations[0].city).toBe("کراچی 🌍");
});
it("keeps company readiness available when an operator supplies a malformed host mapping", () => {
  process.env.HR_PORTAL_HOSTS = "[=" + tenant;
  expect(jobBoardStatus(tenant, configured())).toMatchObject({
    approvedOrigins: [],
    originApproved: false,
    activeProviders: [],
    feedUrls: { INDEED: null, LINKEDIN: null },
  });
});
it("reports unapproved readiness for malformed saved website data without activating a feed", () => {
  expect(jobBoardStatus(tenant, { ...configured(), careersOrigin: "https://[" })).toMatchObject({
    originApproved: false,
    activeProviders: [],
    feedUrls: { INDEED: null, LINKEDIN: null },
  });
});
