// The session row must be locked by the caller. Clocks are created only when a
// new test starts; tests already in progress retain their original overall clock.
export const hasSectionClocks = (s) =>
  s.blueprintSnapshot.sections.some((section) => section.durationMin != null);
const sections = (s) => s.blueprintSnapshot.sections;
const deadline = (s, index, start) => {
  const minutes = sections(s)[index].durationMin;
  return new Date(
    minutes == null
      ? +s.deadlineAt
      : Math.min(
          +s.deadlineAt,
          +start + minutes * 60000 * (1 + s.extraTimePct / 100),
        ),
  );
};
async function insert(tx, env, s, index, start) {
  const [row] = await tx.$queryRawUnsafe(
    'INSERT INTO "CandidateTestSessionSection" ("tenantId","sessionId","sectionIndex","sectionKey","startedAt","deadlineAt") VALUES ($1::uuid,$2,$3,$4,$5,$6) RETURNING *',
    env.tenantId,
    s.id,
    index,
    sections(s)[index].key,
    start,
    deadline(s, index, start),
  );
  return row;
}
export async function beginSections(tx, env, s) {
  if (!hasSectionClocks(s)) return null;
  return insert(tx, env, s, 0, s.startedAt);
}
export async function activeSection(tx, env, s) {
  if (!hasSectionClocks(s)) return null;
  const rows = await tx.$queryRawUnsafe(
    'SELECT * FROM "CandidateTestSessionSection" WHERE "tenantId"=$1::uuid AND "sessionId"=$2 AND "closedAt" IS NULL',
    env.tenantId,
    s.id,
  );
  return rows[0] ?? null;
}
export function sectionView(s, row, now) {
  if (!row) return null;
  const indices = s.itemOrder.flatMap((item, index) =>
    item.sectionKey === row.sectionKey ? [index] : [],
  );
  const at = s.status === "PAUSED" && s.pausedAt ? s.pausedAt : now;
  return {
    key: row.sectionKey,
    index: row.sectionIndex,
    count: sections(s).length,
    firstIndex: indices[0],
    lastIndex: indices.at(-1),
    deadlineAt: row.deadlineAt,
    remainingSeconds: Math.max(0, Math.floor((row.deadlineAt - at) / 1000)),
    timed: sections(s)[row.sectionIndex].durationMin != null,
    canAdvance: row.sectionIndex < sections(s).length - 1,
  };
}
async function advance(tx, env, s, row, at) {
  await tx.$executeRawUnsafe(
    'UPDATE "CandidateTestSessionSection" SET "closedAt"=$4 WHERE "tenantId"=$1::uuid AND "sessionId"=$2 AND "sectionIndex"=$3 AND "closedAt" IS NULL',
    env.tenantId,
    s.id,
    row.sectionIndex,
    at,
  );
  if (row.sectionIndex + 1 >= sections(s).length) return null;
  const next = await insert(tx, env, s, row.sectionIndex + 1, at);
  const index = s.itemOrder.findIndex(
    (item) => item.sectionKey === next.sectionKey,
  );
  await tx.candidateTestSession.update({
    where: { id: s.id },
    data: {
      currentIndex: index,
      itemStartedAt: at,
      revision: { increment: 1 },
    },
  });
  s.currentIndex = index;
  s.itemStartedAt = at;
  s.revision++;
  return next;
}
export async function reconcileSections(tx, env, s) {
  let row = await activeSection(tx, env, s),
    changed = false;
  if (s.status !== "IN_PROGRESS") return { row, changed, ended: false };
  while (row && row.deadlineAt <= env.now) {
    // Carry the old deadline forward, so being offline cannot create extra time.
    row = await advance(tx, env, s, row, row.deadlineAt);
    changed = true;
  }
  return { row, changed, ended: changed && !row };
}
export async function nextSection(tx, env, s, row) {
  return advance(tx, env, s, row, env.now);
}
export async function adjustSection(tx, env, s, action, previous, input) {
  const row = await activeSection(tx, env, s);
  if (!row || !["RESUME", "EXTEND"].includes(action)) return row;
  const minutes = sections(s)[row.sectionIndex].durationMin;
  const delta =
    action === "RESUME"
      ? env.now - previous.pausedAt
      : ((minutes ?? s.blueprintSnapshot.durationMin) *
          60000 *
          input.extraTimePct) /
        100;
  const next = new Date(Math.min(+s.deadlineAt, +row.deadlineAt + delta));
  await tx.$executeRawUnsafe(
    'UPDATE "CandidateTestSessionSection" SET "deadlineAt"=$4 WHERE "tenantId"=$1::uuid AND "sessionId"=$2 AND "sectionIndex"=$3',
    env.tenantId,
    s.id,
    row.sectionIndex,
    next,
  );
  return { ...row, deadlineAt: next };
}
