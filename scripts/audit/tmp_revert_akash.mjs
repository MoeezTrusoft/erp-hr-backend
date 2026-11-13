import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

await mcpCtx.run({ system: true }, async () => {
  const row = await prisma.attendance.findFirst({
    where: { employeeId: 160, date: new Date('2026-08-29T00:00:00.000Z') },
  });
  if (!row) { console.log('row not found'); return; }
  console.log('current:', row.status, row.day_credit, row.remarks);
  if (row.status === 'PRESENT' && (row.remarks || '').includes('non-attendance-tracked')) {
    await prisma.attendance.update({
      where: { id: row.id },
      data: { status: 'ABSENT', day_credit: 0, remarks: 'device' },
    });
    console.log('reverted to ABSENT (device-sourced real absence)');
  } else {
    console.log('no revert needed');
  }
});

await prisma.$disconnect();
