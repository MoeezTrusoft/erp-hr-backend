export async function loadEvaluationEvidence(
  db,
  tenantId,
  from,
  to,
  employeeIds,
) {
  const [events, devices] = await Promise.all([
    db.attendanceCaptureEvent.findMany({
      where: { tenantId, state: { in: ["PENDING", "FAILED", "NEEDS_REVIEW"] } },
      select: {
        id: true,
        employeeId: true,
        sn: true,
        parsed: true,
        state: true,
        reason: true,
        createdAt: true,
      },
    }),
    db.attendanceCaptureDevice.findMany({
      where: { OR: [{ tenantId }, { allowedTenantIds: { has: tenantId } }] },
    }),
  ]);
  return { events, devices };
}
export function evidenceHolds(session, context, now) {
  const info = session.setupSnapshot,
    shift = session.shift;
  const projected = new Set(session.evidence.map((p) => p.eventId));
  const allowedSn = new Set(
    [
      info.primarySn,
      ...(info.deviceSites || [])
        .filter((d) => info.siteAssignment?.siteIds?.includes(d.siteId))
        .map((d) => d.sn),
    ].filter(Boolean),
  );
  const holds = [];
  for (const e of context.events) {
    if (projected.has(e.id) && e.state !== "NEEDS_REVIEW") continue;
    if (
      e.employeeId !== session.employeeId &&
      !(e.employeeId == null && allowedSn.has(e.sn))
    )
      continue;
    const at = e.parsed?.punchedAt ? new Date(e.parsed.punchedAt) : null;
    const sameWindow =
      at &&
      (shift?.start && shift?.end
        ? at >= new Date(+shift.start - 5 * 3600000) &&
          at <= new Date(+shift.end + 9 * 3600000)
        : at.toISOString().slice(0, 10) ===
          session.day.toISOString().slice(0, 10));
    if (sameWindow || (!at && allowedSn.has(e.sn)))
      holds.push({
        code: "CAPTURE_" + e.state,
        eventId: e.id,
        reason: e.reason,
      });
  }
  if (
    !session.evidence.length &&
    info.working &&
    info.reason !== "PAID_NO_PUNCH"
  ) {
    for (const device of context.devices.filter((d) => allowedSn.has(d.sn))) {
      const deadline = session.deadline || now;
      const lastSeen = device.lastSeenAt && new Date(device.lastSeenAt);
      if (
        !device.active ||
        !lastSeen ||
        +lastSeen + (device.staleAfterMinutes || 30) * 60000 <
          Math.min(+deadline, +now)
      )
        holds.push({ code: "DEVICE_DATA_UNCONFIRMED", sn: device.sn });
    }
  }
  return holds;
}
