import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const NAMES = ['jamshed', 'tanveer', 'usman', 'akash', 'abidi'];

await mcpCtx.run({ system: true }, async () => {
  const emps = await prisma.employee.findMany({
    select: { id: true, first_name: true, last_name: true, tenant_id: true, status: true },
  });
  const picked = emps.filter((e) => {
    const full = `${e.first_name || ''} ${e.last_name || ''}`.toLowerCase();
    return NAMES.some((n) => full.includes(n));
  });
  console.log(`candidates: ${picked.length}`);
  for (const e of picked) {
    const rows = await prisma.attendance.findMany({
      where: { employeeId: e.id, tenantId: e.tenant_id, status: 'ABSENT', date: { gte: new Date('2026-08-01T00:00:00Z'), lt: new Date('2026-09-01T00:00:00Z') } },
      select: { id: true, date: true, remarks: true },
      orderBy: { date: 'asc' },
    });
    console.log(`emp=${e.id} "${e.first_name} ${e.last_name || ''}" (${e.status}): ${rows.length} August ABSENT rows`);
    for (const r of rows.slice(0, 3)) console.log(`   ${r.date.toISOString().slice(0, 10)} [${(r.remarks || '').slice(0, 70)}]`);
    if (rows.length > 3) console.log(`   … +${rows.length - 3} more`);
    const upd = await prisma.attendance.updateMany({
      where: { employeeId: e.id, tenantId: e.tenant_id, status: 'ABSENT', date: { gte: new Date('2026-08-01T00:00:00Z'), lt: new Date('2026-09-01T00:00:00Z') } },
      data: { status: 'PRESENT', day_credit: 1.0, remarks: 'POLICY 2026-09-11: non-attendance-tracked staff (HR register charges 0); blank scheduled days paid' },
    });
    if (upd.count) console.log(`   → flipped ${upd.count} to PRESENT`);
  }
});

await prisma.$disconnect();
