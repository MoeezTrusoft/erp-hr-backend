import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomInt } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_RECRUITMENT_ONSITE_TEST = "on";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const tenant = randomUUID(),
  foreign = randomUUID();
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XkAAAAASUVORK5CYII=",
  "base64",
);
let bytes = png,
  asset,
  uploads = 0,
  requests = [];
const resetAsset = () => {
  bytes = png;
  asset = {
    id: 41,
    tenantId: tenant,
    sha256: createHash("sha256").update(png).digest("hex"),
    mimeType: "image/png",
    filename: "diagram.png",
    size: png.length,
    assetScan: { tenantId: tenant, status: "CLEAN" },
    isDeleted: false,
  };
};
resetAsset();
const server = createServer(async (req, res) => {
  requests.push(req.headers["x-tenant-id"]);
  if (req.url === "/api/assets/upload") {
    for await (const chunk of req) void chunk;
    uploads++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items: [{ id: 41 }] }));
    return;
  }
  if (req.url === "/api/assets/video-stream/41") {
    res.setHeader("Content-Type", asset.mimeType);
    res.end(bytes);
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(asset));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.DAM_SERVICE_URL =
  "http://127.0.0.1:" + server.address().port + "/api";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const images =
  await import("../../src/services/candidate-assessment/images.js");
const catalog =
  await import("../../src/services/candidate-assessment/catalog.js");
const adminUrl = new URL(process.env.ASSESSMENT_TEST_ADMIN_URL || "http://invalid");
if (adminUrl.hostname !== url.hostname || adminUrl.port !== url.port ||
    adminUrl.pathname !== url.pathname || adminUrl.username !== "postgres" || !adminUrl.password)
  throw new Error("Explicit isolated fixture owner connection required");
const admin = new pg.Client({ connectionString: adminUrl.href });
let author, reviewer, skill, item, image;
const scope = (tid, fn) => mcpCtx.run({ user: { tenantId: tid } }, async () => await fn());
const as = (
  fn,
  who = author,
  tid = tenant,
  permissions = ["read", "create", "update", "publish"],
) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tid, userId: who.userId, roles: ["HR_ADMIN"] },
      permissions: permissions.map((p) => "hr.recruitment.assessment." + p),
    },
    fn,
  );
const definition = () => ({
  itemCode: "IMAGE-" + randomUUID(),
  type: "IMAGE_SINGLE",
  stem: "Which diagram shows the complete process?",
  mediaId: "41",
  options: [
    { key: "A", text: "First" },
    { key: "B", text: "Second" },
  ],
  answerKey: { keys: ["A"] },
  difficulty: "EASY",
  competencyKey: "PROCESS",
  skillId: skill.id,
  jobFamily: "Operations",
  rationale: "The first diagram includes all required stages.",
});
test.before(async () => {
  await admin.connect();
  await scope(tenant, async () => {
    const staff = (n) => ({
      tenant_id: tenant,
      userId: randomInt(10000, 100000000),
      employee_code: n + "-" + randomUUID().toUpperCase(),
      employeeCategory: "EMPLOYEE",
      first_name: n,
      status: "Active",
      employement_status: "Active",
    });
    author = await db.employee.create({ data: staff("AUTHOR") });
    reviewer = await db.employee.create({ data: staff("REVIEWER") });
    skill = await db.skill.create({
      data: { tenantId: tenant, name: "Image skill " + randomUUID() },
    });
  });
});
test("uploaded image is scanned, tenant verified, deduplicated and previewed without storage URLs", async () => {
  image = await as(() =>
    images.imageUpload({
      fileName: "diagram.png",
      fileBase64: png.toString("base64"),
    }),
  );
  assert.equal(uploads, 1);
  assert.equal(image.mediaId, "41");
  assert.equal(image.sha256, asset.sha256);
  assert.equal(image.url, undefined);
  assert.deepEqual(
    await as(() => images.imageRegister({ mediaId: "41" })),
    image,
  );
  const preview = await as(() => images.imagePreview({ id: image.id }));
  assert.equal(preview.base64, png.toString("base64"));
  assert.ok(requests.every((t) => t === tenant));
});
test("invalid, oversized and unscanned files cannot be registered", async () => {
  await assert.rejects(
    as(() =>
      images.imageUpload({
        fileName: "bad.svg",
        fileBase64: Buffer.from("<svg/>").toString("base64"),
      }),
    ),
    /PNG/,
  );
  assert.throws(() => images.inspectImage(Buffer.alloc(2097153)), /2 MB/);
  await assert.rejects(
    as(() => images.imageUpload({ fileName: "bad.png", fileBase64: "%%%" })),
    /Invalid image/,
  );
  asset.assetScan.status = "PENDING";
  await assert.rejects(
    as(() => images.imageRegister({ mediaId: "41" })),
    /malware scan/,
  );
  resetAsset();
  asset.rightsStatus = "expired";
  await assert.rejects(
    as(() => images.imageRegister({ mediaId: "41" })),
    (e) => e.status === 403,
  );
  resetAsset();
  assert.equal(uploads, 1);
});
test("foreign DAM metadata and absent creation permission are rejected", async () => {
  asset.tenantId = foreign;
  await assert.rejects(
    as(() => images.imageRegister({ mediaId: "41" })),
    (e) => e.status === 404,
  );
  resetAsset();
  await assert.rejects(
    as(
      () =>
        images.imageUpload({
          fileName: "diagram.png",
          fileBase64: png.toString("base64"),
        }),
      author,
      tenant,
      ["read"],
    ),
    (e) => e.status === 403,
  );
  assert.equal(uploads, 1);
});
test("draft saves pin verified bytes and independent review publishes the exact image", async () => {
  item = await as(() => catalog.itemCreate({ item: definition() }));
  const read = await as(() => catalog.itemGet({ id: item.id }));
  assert.equal(read.image.sha256, image.sha256);
  item = await as(() =>
    catalog.itemSubmit({ id: item.id, expectedVersion: item.revision }),
  );
  item = await as(
    () =>
      catalog.itemReview({
        id: item.id,
        expectedVersion: item.revision,
        approve: true,
        reason: "Independently verified the diagram and answer.",
      }),
    reviewer,
  );
  assert.equal(item.status, "PUBLISHED");
  const downloaded = await scope(tenant, () =>
    images.downloadPinnedImage(read.image, tenant),
  );
  assert.deepEqual(downloaded.buffer, png);
});
test("published image bindings and metadata cannot be rewritten, including with administrator SQL", async () => {
  await assert.rejects(
    admin.query(
      'UPDATE "CandidateTestItemImage" SET "imageId"=$1 WHERE "itemId"=$2',
      [image.id, item.id],
    ),
    /immutable/,
  );
  await assert.rejects(
    admin.query('UPDATE "CandidateAssessmentImage" SET sha256=$1 WHERE id=$2', [
      "a".repeat(64),
      image.id,
    ]),
    /immutable/,
  );
});
test("changed DAM bytes cannot alter a published image or pass its preview", async () => {
  bytes = Buffer.concat([png, Buffer.from("changed")]);
  asset.sha256 = createHash("sha256").update(bytes).digest("hex");
  asset.size = bytes.length;
  await assert.rejects(
    as(() => images.imagePreview({ id: image.id })),
    /content has changed/,
  );
  await assert.rejects(
    scope(tenant, () => images.downloadPinnedImage(image, tenant)),
    /content has changed/,
  );
  resetAsset();
});
test("tenant RLS hides image inventory and composite FK rejects foreign bindings", async () => {
  const rows = await scope(foreign, () =>
    db.$queryRawUnsafe(
      'SELECT id FROM "CandidateAssessmentImage" WHERE id=$1',
      image.id,
    ),
  );
  assert.equal(rows.length, 0);
  await assert.rejects(
    admin.query(
      'INSERT INTO "CandidateTestItemImage" ("itemId","tenantId","imageId") VALUES ($1,$2,$3)',
      [item.id, foreign, image.id],
    ),
    /foreign key|duplicate key/,
  );
});
test("failed DAM byte verification rolls back the item draft", async () => {
  bytes = Buffer.from("wrong bytes");
  const count = await scope(tenant, () =>
    db.candidateTestItem.count({ where: { tenantId: tenant } }),
  );
  await assert.rejects(as(() => catalog.itemCreate({ item: definition() })));
  assert.equal(
    await scope(tenant, () =>
      db.candidateTestItem.count({ where: { tenantId: tenant } }),
    ),
    count,
  );
  resetAsset();
});
test.after(async () => {
  await admin.query('DELETE FROM "CandidateTestItem" WHERE "tenantId"=$1', [
    tenant,
  ]);
  await admin.query(
    'DELETE FROM "CandidateAssessmentImage" WHERE "tenantId"=$1',
    [tenant],
  );
  await scope(tenant, async () => {
    await db.skill.deleteMany({ where: { tenantId: tenant } });
    await db.employee.deleteMany({ where: { tenant_id: tenant } });
  });
  await admin.end();
  await db.$disconnect();
  await new Promise((r) => server.close(r));
});
