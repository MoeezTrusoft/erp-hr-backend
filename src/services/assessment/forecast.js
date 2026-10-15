import { createHash } from "node:crypto";
import { eligibility } from "@trusoft/contracts/assessment-rules";
import { loadAttendanceRuntime } from "../../lib/attendanceRuntime.js";
import { dateRange } from "../../lib/attendanceDates.js";
import { scopeKey } from "./base.js";
import { equivalentCapabilities } from "./equivalence.js";

const stableId = (value) => {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export function aggregateForecast(people, horizons) {
  const groups = new Map();
  for (const horizon of horizons)
    for (const person of people) {
      const window = person.windows.find((w) => w.days === horizon.days);
      if (!window?.profile) continue;
      for (const requirement of window.profile.requirements) {
        const task = window.tasks.find(
          (t) =>
            t.taskCode === requirement.taskCode &&
            t.taskVersion === requirement.taskVersion,
        );
        if (!task) continue;
        const scope = scopeKey(task),
          matched = person.capabilities.filter(
            (c) =>
              c.taskCode === task.taskCode &&
              c.taskVersion === task.taskVersion &&
              c.scopeKey === scope,
          );
        const required = ["K", "S"].filter(
          (d) => requirement[d === "K" ? "requiredK" : "requiredS"] != null,
        );
        const restricted = person.restrictions.some(
          (r) => r.taskCode === task.taskCode && !r.liftedAt,
        );
        const pending = required.some(
          (d) =>
            !matched.some(
              (c) =>
                c.dimension === d &&
                ["CURRENT", "HELD", "EXPIRED"].includes(c.status) &&
                c.score != null,
            ),
        );
        const expired = required.some((d) =>
          matched.some(
            (c) =>
              c.dimension === d &&
              +new Date(c.expiresAt) <= +new Date(horizon.at),
          ),
        );
        const technicallyEligible =
          required.length > 0 &&
          eligibility({
            requirements: [{ ...requirement, scopeKey: scope }],
            capabilities: matched,
            restrictions: person.restrictions,
            prerequisites: window.credentials,
            now: new Date(horizon.at),
          }).eligible;
        const renewal = person.renewals.some(
          (r) =>
            r.taskCodes.includes(task.taskCode) &&
            +new Date(r.dueAt) <= +new Date(horizon.at),
        );
        for (const site of new Set(
          window.sites.length ? window.sites : ["UNCONFIRMED"],
        )) {
          const key = `${horizon.days}:${task.taskCode}:${task.taskVersion}:${scope}:${site}`;
          let row = groups.get(key);
          if (!row) {
            row = {
              id: stableId(key),
              days: horizon.days,
              at: horizon.at,
              taskCode: task.taskCode,
              taskVersion: task.taskVersion,
              scope,
              site,
              employees: 0,
              eligible: 0,
              calendarAvailable: 0,
              pendingEvidence: 0,
              expiredEvidence: 0,
              restricted: 0,
              notApplicable: 0,
              calendarUnconfirmed: 0,
              scheduledRenewals: 0,
            };
            groups.set(key, row);
          }
          row.employees++;
          if (technicallyEligible) row.eligible++;
          if (technicallyEligible && window.availableSites.includes(site))
            row.calendarAvailable++;
          if (pending) row.pendingEvidence++;
          if (expired) row.expiredEvidence++;
          if (restricted) row.restricted++;
          if (!required.length) row.notApplicable++;
          if (window.calendarUnconfirmed) row.calendarUnconfirmed++;
          if (renewal) row.scheduledRenewals++;
        }
      }
    }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function workforceForecast(tx, env) {
  const horizonDays = [0, 90, 180],
    horizons = horizonDays.map((days) => ({
      days,
      at: new Date(+env.now + days * 86400000).toISOString(),
    }));
  const identities = await tx.assessmentIdentity.findMany({
    where: { tenantId: env.tenantId, active: true },
  });
  const employees = await tx.employee.findMany({
    where: {
      tenant_id: env.tenantId,
      id: { in: identities.map((p) => p.employeeRowId) },
    },
    select: {
      id: true,
      employee_code: true,
      positionId: true,
      employement_status: true,
      status: true,
      fte: true,
    },
  });
  const profiles = await tx.assessmentProfileVersion.findMany({
    where: { tenantId: env.tenantId, status: "PUBLISHED" },
  });
  const bindings = await tx.employeeAssessmentProfile.findMany({
    where: {
      tenantId: env.tenantId,
      effectiveFrom: { lte: new Date(horizons.at(-1).at) },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: env.now } }],
    },
  });
  const tasks = await tx.assessmentTaskVersion.findMany({
    where: { tenantId: env.tenantId, status: "PUBLISHED" },
  });
  const capabilities = await equivalentCapabilities(
    tx,
    env.tenantId,
    await tx.assessmentCapability.findMany({
      where: { tenantId: env.tenantId },
    }),
  );
  const restrictions = await tx.assessmentRestriction.findMany({
    where: { tenantId: env.tenantId, liftedAt: null },
  });
  const credentials = await tx.certification.findMany({
    where: { tenantId: env.tenantId, status: "ACTIVE" },
  });
  const renewals = await tx.assessmentAssignment.findMany({
    where: {
      tenantId: env.tenantId,
      purpose: "RENEWAL",
      state: {
        in: [
          "ASSIGNED",
          "IN_PROGRESS",
          "RETURNED",
          "UNDER_REVIEW",
          "ACKNOWLEDGMENT_DUE",
          "ACKNOWLEDGED",
        ],
      },
    },
  });
  const training = await tx.trainingSessionAttendee.findMany({
    where: { tenantId: env.tenantId },
    include: { session: true },
  });
  const runtimes = [];
  for (const horizon of horizons) {
    const from = horizon.at.slice(0, 10),
      to = new Date(Date.parse(horizon.at) + 6 * 86400000)
        .toISOString()
        .slice(0, 10);
    runtimes.push({
      days: horizon.days,
      from,
      to,
      runtime: await loadAttendanceRuntime({
        tenantId: env.tenantId,
        from,
        to,
        db: tx,
      }),
    });
  }
  const people = [];
  let unresolvedIdentities = 0,
    unmappedProfiles = 0;
  for (const person of identities) {
    const employee = employees.find((e) => e.id === person.employeeRowId);
    if (
      !employee ||
      employee.employee_code?.trim() !== person.employeeCode ||
      String(employee.positionId ?? "") !== String(person.positionRef ?? "") ||
      /inactive|terminated|exited|offboard/i.test(
        `${employee.employement_status || ""} ${employee.status || ""}`,
      )
    ) {
      unresolvedIdentities++;
      continue;
    }
    const windows = [];
    for (const horizon of horizons) {
      const matches = bindings.filter(
        (b) =>
          b.employeeCode === person.employeeCode &&
          +b.effectiveFrom <= Date.parse(horizon.at) &&
          (!b.effectiveUntil || +b.effectiveUntil > Date.parse(horizon.at)),
      );
      const profile =
        matches.length === 1 &&
        profiles.find(
          (p) =>
            p.id === matches[0].profileRef &&
            p.positionRef === person.positionRef,
        );
      if (!profile) {
        unmappedProfiles++;
        continue;
      }
      const calendar = runtimes.find((r) => r.days === horizon.days),
        sites = new Set(),
        availableSites = new Set();
      let calendarUnconfirmed = false;
      for (const date of dateRange(calendar.from, calendar.to, 8)) {
        const info = calendar.runtime.resolve(person.employeeRowId, date);
        if (info.working == null) calendarUnconfirmed = true;
        if (info.siteAssignment?.siteCode)
          sites.add(info.siteAssignment.siteCode);
        const inTraining = training.some(
          (a) =>
            a.employeeId === person.employeeRowId &&
            a.session.scheduledAt?.toISOString().slice(0, 10) === date,
        );
        if (
          info.working === true &&
          info.shift?.start &&
          info.shift?.end &&
          (employee.fte ?? 1) > 0 &&
          !inTraining
        )
          availableSites.add(info.siteAssignment?.siteCode || "UNCONFIRMED");
      }
      windows.push({
        days: horizon.days,
        profile: profile.definition,
        tasks: tasks.map((t) => t.definition),
        sites: [...sites],
        availableSites: [...availableSites],
        calendarUnconfirmed,
        credentials: credentials
          .filter(
            (c) =>
              c.employeeId === person.employeeRowId &&
              (!c.expiryDate || +c.expiryDate > Date.parse(horizon.at)),
          )
          .map((c) => c.credentialId)
          .filter(Boolean),
      });
    }
    people.push({
      employeeCode: person.employeeCode,
      windows,
      capabilities: capabilities.filter(
        (c) => c.employeeCode === person.employeeCode,
      ),
      restrictions: restrictions.filter(
        (r) => r.employeeCode === person.employeeCode,
      ),
      renewals: renewals.filter((r) => r.employeeCode === person.employeeCode),
    });
  }
  return {
    items: aggregateForecast(people, horizons),
    unresolvedIdentities,
    unmappedProfileWindows: unmappedProfiles,
    asOf: env.now.toISOString(),
    basis:
      "Distinct employees per task scope/site in current, 90-day and 180-day windows. Scheduled renewals remain conditional and never count as passed evidence. Calendar availability is the next seven days; PM separately verifies assignments, tools and capacity before commitment.",
  };
}
