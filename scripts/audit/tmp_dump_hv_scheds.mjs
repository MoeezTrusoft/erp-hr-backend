import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

await mcpCtx.run({ system: true }, async () => {
  const scheds = await prisma.workSchedule.findMany({
    where: { employeeId: { in: [160, 161, 162, 163, 164, 165, 166, 167, 168, 172] } },
    select: { employeeId: true, schedule_name: true, schedule_pattern: true, effective_start_date: true, effective_end_date: true },
    orderBy: { employeeId: 'asc' },
  });
  for (const s of scheds) {
    console.log(`emp=${s.employeeId} name="${s.schedule_name}" from=${s.effective_start_date?.toISOString?.().slice(0, 10)} to=${s.effective_end_date?.toISOString?.().slice(0, 10) ?? '-'} pattern=${JSON.stringify(s.schedule_pattern)}`);
  }
});

await prisma.$disconnect();
