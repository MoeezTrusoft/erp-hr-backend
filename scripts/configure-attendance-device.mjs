// Operations-only shared-device authorization. Preview first; apply the exact
// reviewed configuration by passing its token. Never expose this in tenant UI.
import prisma from "../src/lib/prisma.js";
import { configureSharedCaptureDevice } from "../src/services/attendanceCapture.service.js";
const args = process.argv.slice(2);
const value = (key) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
try {
  const result = await configureSharedCaptureDevice({
    sn: value("--sn"),
    allowedTenantIds: value("--tenants")?.split(","),
    actorId: value("--operator"),
    reason: value("--reason"),
    previewToken: value("--apply-token"),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}
