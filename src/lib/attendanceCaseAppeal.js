// HR-ATT-APPEAL-01 (2026-11-06) — an appeal is a NEW case linked to the rejected
// one (`appealOfAnomalyId`); the rejected case keeps its decision on record and
// is marked SUPERSEDED. The Timesheet therefore needs two facts about a case:
// whether the server would accept an appeal now, and whether one already links
// to it (so the screen never offers a button the server must refuse).
//
// The eligibility rules are the ones `openAppealCase` enforces: rules v2, a
// Management rejection whose evidence is still live, and no open appeal.

/**
 * original anomaly id -> the appeal raised against it. The cases arrive newest
 * first (the read model queries createdAt desc), so the first one wins and an
 * older appeal can never displace the live one.
 */
export function appealsByOriginal(cases = []) {
  const map = new Map();
  for (const row of cases ?? []) {
    if (row?.appealOfAnomalyId == null) continue;
    if (!map.has(row.appealOfAnomalyId)) map.set(row.appealOfAnomalyId, row);
  }
  return map;
}

/**
 * What the row detail may say about an appeal of this case.
 * `canAppeal` mirrors the server's own test; `appealId` is set once an appeal
 * exists, whatever its state, so the screen can point at it instead of offering
 * a second one.
 */
export function appealInfo(anomaly, appeals = new Map()) {
  if (!anomaly) return { canAppeal: false, appealId: null, appealOf: null };
  const appeal = appeals.get(anomaly.id) ?? null;
  return {
    canAppeal:
      Number(anomaly.rulesVersion) === 2 &&
      anomaly.status === "REJECTED" &&
      anomaly.decisionRole === "Management" &&
      anomaly.evidenceState === "ACTIVE" &&
      appeal == null,
    appealId: appeal?.id ?? null,
    appealOf: anomaly.appealOfAnomalyId ?? null,
  };
}
