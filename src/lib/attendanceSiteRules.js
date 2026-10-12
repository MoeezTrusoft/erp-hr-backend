export function evaluateSiteEvidence(punches, info, credits = []) {
  const issues = [];
  if (!info.sites?.length) return issues; // Existing deployments opt in by publishing their sites.
  const authorized = info.siteAssignment?.siteIds || [];
  const mapped = punches.map((p) => ({
    ...p,
    siteId: p.siteId || info.deviceSites?.find((d) => d.sn === p.sn)?.siteId,
  }));
  for (const p of mapped) {
    if (!p.siteId) issues.push({ code: "SITE_NOT_MAPPED", eventId: p.eventId });
    else if (!authorized.includes(p.siteId))
      issues.push({
        code: "SITE_NOT_ASSIGNED",
        siteId: p.siteId,
        eventId: p.eventId,
      });
  }
  for (let i = 1; i < mapped.length; i++) {
    const a = mapped[i - 1],
      b = mapped[i];
    if (!a.siteId || !b.siteId || a.siteId === b.siteId) continue;
    const minutes =
      (+new Date(b.occurredAt || b.timestamp) -
        +new Date(a.occurredAt || a.timestamp)) /
      60000;
    const route = info.siteRoutes?.find(
      (r) => r.fromSiteId === a.siteId && r.toSiteId === b.siteId,
    );
    const approved = credits.some(
      (c) =>
        c.kind === "TRAVEL" &&
        c.fromSiteId === a.siteId &&
        c.toSiteId === b.siteId &&
        +new Date(c.start) <= +a.timestamp &&
        +new Date(c.end) >= +b.timestamp,
    );
    if (a.type !== "OUT" || b.type !== "IN")
      issues.push({
        code: "CROSS_SITE_OPEN_INTERVAL",
        fromSiteId: a.siteId,
        toSiteId: b.siteId,
      });
    if (route && minutes < route.minimumMinutes)
      issues.push({
        code: "IMPLAUSIBLE_SITE_TRANSFER",
        minutes,
        minimumMinutes: route.minimumMinutes,
      });
    if (!approved)
      issues.push({
        code: "SITE_TRANSFER_REVIEW",
        fromSiteId: a.siteId,
        toSiteId: b.siteId,
      });
  }
  return issues;
}
