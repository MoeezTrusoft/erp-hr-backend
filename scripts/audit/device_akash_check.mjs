// Device intake probe: are Akash's two site devices (Johar 175.107.244.180,
// Dalmia 124.29.225.244) already feeding the server via ADMS push? List known
// devices, September punch coverage per device, and any punches for Akash.
import { mcpCtx } from '../../src/mcp/context.js';
import prisma from '../../src/lib/prisma.js';

const SEP0 = new Date('2026-09-01T00:00:00.000Z');

await mcpCtx.run({ system: true }, async () => {
  const models = Object.keys(prisma).filter((k) => /device|punch/i.test(k));
  console.log('device-ish models:', models.join(', '));

  // Registered devices (any model shape)
  for (const m of models) {
    try {
      const rows = await prisma[m].findMany({ take: 50 });
      if (!rows.length) continue;
      console.log(`\n== ${m} (${rows.length}) ==`);
      for (const r of rows.slice(0, 20)) {
        console.log(JSON.stringify(r).slice(0, 240));
      }
    } catch { /* model exists but not a plain table */ }
  }

  // Akash punches in September, both employee ids
  for (const [label, eid] of [['Akash JOC (554)', 554], ['Akash HomeVision (160)', 160]]) {
    try {
      const att = await prisma.attendance.count({ where: { employeeId: eid, date: { gte: SEP0 } } });
      console.log(`\n${label}: September attendance rows = ${att}`);
      const recent = await prisma.attendance.findMany({
        where: { employeeId: eid, date: { gte: SEP0 } },
        orderBy: { date: 'desc' }, take: 5,
        select: { date: true, status: true, day_credit: true },
      });
      for (const r of recent) console.log('  ', JSON.stringify(r));
    } catch (e) { console.log(`${label}: ${e.message.slice(0, 120)}`); }
  }
});
await prisma.$disconnect();
process.exit(0);
