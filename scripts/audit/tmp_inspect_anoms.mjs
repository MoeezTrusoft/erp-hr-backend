import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

await mcpCtx.run({ system: true }, async () => {
  const groups = await prisma.attendanceAnomaly.groupBy({
    by: ['sourceKind', 'status', 'type'],
    _count: { _all: true },
  });
  console.log('--- grouped by sourceKind/status/type ---');
  for (const g of groups) console.log(g.sourceKind ?? '(null)', g.status, g.type, g._count._all);

  const rows = await prisma.attendanceAnomaly.findMany({
    where: { sourceKind: { not: null } },
    select: { id: true, tenantId: true, employeeId: true, type: true, status: true, date: true, sourceKind: true, sourceRef: true, reason: true },
    orderBy: [{ sourceRef: 'asc' }, { date: 'asc' }],
  });
  console.log(`--- ${rows.length} rows with sourceKind ---`);
  for (const r of rows) {
    console.log(`#${r.id} t=${(r.tenantId || '').slice(0, 8)} emp=${r.employeeId} ${r.type}/${r.status} ${r.date?.toISOString().slice(0, 10)} kind=${r.sourceKind} ref=${r.sourceRef} | ${(r.reason || '').slice(0, 60)}`);
  }
});

await prisma.$disconnect();
