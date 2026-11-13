// September intake check: Attendance rows + device punch recency per tenant,
// post-deploy. Read-only.
import { mcpCtx } from '../../src/mcp/context.js';
import prisma from '../../src/lib/prisma.js';

const SEP_START = new Date('2026-09-01T00:00:00Z');

const TENANTS = [
  ['Trusoft', '40314ef4-0a81-4390-b631-b3ad3f21f523'],
  ['Homenet', '8ff0533b-62f6-4be9-a78e-69adf49e00bc'],
  ['HomeVision', '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'],
  ['JOC', '8f4a526f-d45b-4da2-b772-d6682e849812'],
  ['BOC', '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2'],
];

await mcpCtx.run({ system: true }, async () => {
  for (const [name, id] of TENANTS) {
    const t = { id };
    const [attCount, lastAtt, lastPunch] = await Promise.all([
      prisma.attendance.count({ where: { tenantId: t.id, date: { gte: SEP_START } } }),
      prisma.attendance.findFirst({
        where: { tenantId: t.id, date: { gte: SEP_START } },
        orderBy: { date: 'desc' },
        select: { date: true, status: true },
      }),
      prisma.attendanceDevicePunch.findFirst({
        where: { tenantId: t.id, punchedAt: { gte: SEP_START } },
        orderBy: { punchedAt: 'desc' },
        select: { punchedAt: true, sn: true },
      }),
    ]);
    const lp = lastPunch ? `${lastPunch.punchedAt?.toISOString?.() ?? lastPunch.punchedAt} (sn=${lastPunch.sn ?? '?'})` : 'NONE';
    console.log(`${name.padEnd(12)} attRows=${String(attCount).padStart(4)}  lastAtt=${lastAtt ? lastAtt.date.toISOString().slice(0, 10) + '/' + lastAtt.status : 'NONE'}  lastPunch=${lp}`);
  }
});
await prisma.$disconnect();
process.exit(0);
