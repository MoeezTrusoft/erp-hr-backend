import {capDailyOvertime} from './attendanceOvertime.js';
// src/lib/attendanceReplay.js
//
// Shared replay core for the two analysis reports: the status shadow-diff and
// the deduction dry-run.
//
// Extracted rather than copied. If the two reports sessionised punches
// separately they could disagree, and the whole point of both is to be believed
// — a status report and a money report that count different shifts are worse
// than no report at all.
//
// Read-only. Nothing here writes.
//
// HR-ATT-POLICY-01.
import prisma from "./prisma.js";
import { evaluateShift } from "./attendanceEvaluator.js";
import { loadAttendanceRuntime } from "../services/attendanceSetup.service.js";
import { civilNow, civilInstant } from './attendanceClock.js';
import { dateRange } from './attendanceDates.js';
import { evaluateSiteEvidence } from './attendanceSiteRules.js';

import { shiftFor, shiftCandidates } from './attendanceShift.js';
export { shiftFor, shiftCandidates };

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

export const startOfDay = (v) => { const d = new Date(v); d.setUTCHours(0, 0, 0, 0); return d; };
export const dayKey = (d) => startOfDay(d).toISOString().slice(0, 10);

/** "HH:MM" anchored to a day; a night shift rolls its end into the next one. */
/**
 * Every shift window a roster can put on this day. One entry for a fixed
 * roster; for a rotating one (HR-ATT-ROTATING-01) every alternative, because
 * "10am/pm – 10am/pm" has no single start time.
 */
/**
 * Group punches into shifts by ANCHORING THEM TO THE ROSTER.
 *
 * The previous rule — start a new shift whenever two punches are more than N
 * hours apart — cannot work here. Shifts run 12 to 16 hours (Abdul Rasool
 * 06:49-19:04, Rustam 17:37-09:27), so any gap small enough to separate two
 * shifts is also small enough to cut one shift in half. At 11h it split 12h+
 * shifts and manufactured one orphan arrival plus one orphan departure each
 * time; at 13h it merged sparse employees into 756-hour "shifts". Measured
 * against HR's reconciled record: gap-based grouping reported ~50% of shifts
 * incomplete where HR has 98% complete.
 *
 * So each punch is assigned to the rostered shift window it belongs to, which
 * is what HR does by hand. Employees with no roster fall back to calendar day.
 *
 * Direction: the device code is trusted as a HINT but the position decides.
 * People genuinely press the wrong key — Abdul Rasool's 06:42 arrival on 2 Aug
 * is stamped Check-Out. The first punch of a shift is the arrival and the last
 * is the departure; where that contradicts the device, the punch is corrected
 * and a warning is recorded for HR to confirm or overturn.
 */
export function sessioniseByRoster(
  punches,
  pattern,
  // ATT-CLOSE-9H-01 (2026-10-01) — closeHours 8→9. Trusoft's 15:00–00:00
  // Moeez/Subhan crew scanned OUT at 08:30, 8.5h past the rostered end, and
  // the 8h close window refused the punch: it opened a phantom next-day
  // session and the day's real arrival then paired with IT, turning the
  // departure into the next day's check-in. HR: shifts end when the work
  // ends, never more than nine hours after. The nearest-next-start guard
  // still protects day-shift crews whose 08:30 punch is minutes from a
  // 09:00 rostered arrival.
  { windowHours = 5, dedupeSeconds = 120, closeHours = 9, legacyDirectionInference = false } = {},
) {
  const ordered = [...punches].sort((a, b) => a.punchedAt - b.punchedAt);

  // HR-ATT-DUPLICATE-01 — one press, however many records it left.
  //
  // The MB460 repeats a scan: Khurram's every punch appears three times, some
  // four. Left alone the repeats are not merely noise, they invent shifts. The
  // first of three identical 10:11 OUTs closes the open night shift and clears
  // `open`; the second then finds nothing open, so the stateful rule below
  // reads it as an ARRIVAL and starts a session on what is a rotation rest day.
  // That session holds one punch, so it lands as MISSING_CHECKOUT or ABSENT,
  // and it comes back every time the evaluator runs.
  //
  // The window is 2 minutes: enough for a double-tap and for the 22:02/22:03
  // straddle of a slow finger, far short of two genuine events, which on a
  // 12-hour roster are hours apart.
  const sorted = [];
  const dedupeMs = dedupeSeconds * 1000;
  for (const p of ordered) {
    const prev = sorted[sorted.length - 1];
    if (prev && p.punchedAt - prev.punchedAt <= dedupeMs &&
      prev.sn === p.sn && (prev.status === p.status || (legacyDirectionInference && !p.directionVerified && !prev.directionVerified))) continue;
    sorted.push(p);
  }
  if (!sorted.length) return [];

  const hasRoster =
    typeof pattern === "function" ||
    Boolean(pattern?.shift?.from && pattern?.shift?.to) ||
    Boolean(Array.isArray(pattern?.rotatingShifts) && pattern.rotatingShifts.length) ||
    Boolean(pattern?.shifts?.length);
  const groups = new Map();

  // HR-ATT-SESSION-01 — a shift that is OPEN claims the punch that closes it.
  //
  // Scoring each punch independently against the nearest edge cannot work here.
  // A 10:00 scan is exactly on a night shift's END and exactly on the next day
  // shift's START, so distance alone ties every time, and whichever way the tie
  // is broken it is wrong half the time: trusting the device's status byte
  // stranded Ghulam Rasool's mis-stamped 11:27 close as a phantom next-day
  // arrival, and always preferring the earlier window swallowed genuine 10:04
  // day-shift arrivals into the previous night.
  //
  // The domain breaks the tie: you cannot arrive while you are still on shift.
  // So punches are walked in order, and while a shift is open the next punch
  // closes it. Only a punch that no open shift can account for opens a new one.
  let open = null; // { key, start, end } of the shift currently in progress
  const tol = windowHours * 60 * MIN_MS;
  const closeTol = closeHours * 60 * MIN_MS;

  /** Distance from `t` to the nearest rostered START, across a day either side. */
  const toNearestStart = (at) => {
    let best = Infinity;
    for (const offset of [-1, 0, 1]) {
      const anchor = new Date(at.getTime() + offset * DAY_MS);
      for (const { start } of shiftCandidates(pattern, startOfDay(anchor))) {
        if (start) best = Math.min(best, Math.abs(at.getTime() - start.getTime()));
      }
    }
    return best;
  };

  for (const p of sorted) {
    let key = dayKey(p.punchedAt);
    const t = p.punchedAt.getTime();

    if (hasRoster) {
      // HR-ATT-TOLERANCE-01 — a late departure still closes its own shift.
      //
      // The close window was the same 5 hours as everything else. hamza works
      // 15:00-00:00 and left at 05:06 — six minutes outside it — so the shift
      // he was closing stayed open and his scan started a session on a Saturday
      // he does not work. HR: "we don't sometimes leave on time... these next
      // day or deep night check-outs are for previous days."
      //
      // Widening it alone would be reckless: an 8-hour window on a day shift
      // reaches into the next morning and would swallow a real arrival. So past
      // the normal window a punch is only claimed while it stays nearer this
      // shift's END than to any plausible next START.
      const late = open
        && t > open.end + tol
        && t <= open.end + closeTol
        && (t - open.end) < toNearestStart(p.punchedAt);

      // HR-ATT-DIRECTION-02 (2026-10-01) — a device check-out closes the open
      // shift even past the close window's positional logic. Two guards stack
      // ahead of it: the punch must sit within nine hours of the rostered end,
      // and the session must be OPEN — i.e. a genuine earlier punch opened it.
      // The nearest-next-start test is deliberately NOT applied: Moeez's 08:30
      // OUT sits 6.5h from the next 15:00 start but 8.5h from the midnight end,
      // so "nearer the next start" reads it as an arrival — yet a device check-
      // out cannot be an arrival, and the validated device direction
      // (HR-ATT-POLICY-01: 4404 rows, zero disagreements) outranks the
      // positional heuristic. A mis-stamped genuine arrival is protected by the
      // other two guards: its own shift has usually closed already (open=null)
      // or it lands outside the nine-hour window.
      const closesByDevice = open
        && (p.status === 1 || p.status === 5)
        && t > open.end
        && t <= open.end + closeTol;

      // 1. Does this punch belong to the shift already in progress?
      if (open && ((t >= open.start - tol && t <= open.end + tol) || late || closesByDevice)) {
        key = open.key;
        // Past the rostered end, the shift is finished; a later punch is a new
        // arrival rather than a third scan of the same shift.
        if (t >= open.end) open = null;
      } else {
        // 2. Otherwise it opens a shift. Choose the window whose START it is
        //    nearest — an arrival is defined by its start, not by either edge.
        let best = null;
        for (const offset of [-1, 0, 1]) {
          const anchor = new Date(p.punchedAt.getTime() + offset * DAY_MS);
          // A rotating roster offers more than one window per day; the punch has
          // to be tried against each, or a night arrival gets pulled onto the
          // wrong day by the day-shift window.
          for (const { start, end } of shiftCandidates(pattern, startOfDay(anchor))) {
            if (!start || !end) continue;
            if (t < start.getTime() - tol || t > end.getTime() + tol) continue;
            const distance = Math.abs(t - ((!legacyDirectionInference && (p.status===1||p.status===5)) ? end.getTime():start.getTime()));
            if (!best || distance < best.distance) {
              best = {
                distance,
                key: dayKey(startOfDay(anchor)),
                start: start.getTime(),
                end: end.getTime(),
              };
            }
          }
        }
        if (best) {
          key = best.key;
          open = { key: best.key, start: best.start, end: best.end };
        }
      }
    }

    const dayPattern = typeof pattern === 'function' ? pattern(new Date(key+'T00:00:00Z')) : pattern;
    if (dayPattern?.shifts?.length) {
      const candidates = [-1,0,1].flatMap(offset=>{
        const day = startOfDay(new Date(+p.punchedAt+offset*DAY_MS));
        return shiftCandidates(pattern,day).map(s=>({...s,day}));
      });
      const direction = p.status===1||p.status===5 ? 'OUT':'IN';
      const nearest = candidates.filter(s=>t>=+s.start-tol&&t<=+s.end+closeTol)
        .sort((a,b)=>Math.abs(t-+(direction==='OUT'?a.end:a.start))-Math.abs(t-+(direction==='OUT'?b.end:b.start)))[0];
      if(nearest) key=dayKey(nearest.day)+'|'+nearest.start.toISOString();
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const out = [];
  for (const [groupKey, raw] of [...groups.entries()].sort()) {
    const key = groupKey.split('|')[0];
    const list = raw.sort((a, b) => a.punchedAt - b.punchedAt);
    const corrections = [];

    // Explicit directions are authoritative by default. Legacy inference must
    // be selected by the published policy and never overrides verified direction.
    const deviceDir = (st) => (st === 0 || st === 4 ? "IN" : st === 1 || st === 5 ? "OUT" : null);

    // HR-ATT-DIRECTION-01 — with ONE scan, position cannot tell you anything.
    //
    // The positional rule makes the only punch the first punch, so every
    // incomplete shift was stored MISSING_CHECKOUT. Against HR's August
    // workbook that label was wrong for 23 of the 61 incomplete days: a lone
    // 22:15 scan on a 10:00-22:00 shift is a DEPARTURE, and what is missing is
    // the check-IN. HR's own times for those days sit in their check-out
    // column, matching our scan to the minute.
    //
    // The label matters because it sends HR to fill an end — filling an "out"
    // over a scan that IS the out would overwrite the day's only real
    // observation. So a lone punch is timed against the rostered window;
    // without a roster there is nothing to time it against and it stays an
    // arrival, as before.
    const loneDirection = () => {
      if (list.length !== 1) return null;
      const day = startOfDay(new Date(`${key}T00:00:00Z`));
      const t = list[0].punchedAt.getTime();
      let nearest = null;
      for (const { start, end } of shiftCandidates(pattern, day)) {
        if (!start || !end) continue;
        const toStart = Math.abs(t - start.getTime());
        const toEnd = Math.abs(t - end.getTime());
        const d = Math.min(toStart, toEnd);
        if (!nearest || d < nearest.d) nearest = { d, dir: toEnd < toStart ? "OUT" : "IN" };
      }
      return nearest?.dir ?? null;
    };
    const lone = loneDirection();

    const shaped = list.map((p, i) => {
      const evidence = {timestamp:p.punchedAt, occurredAt:p.occurredAt, directionVerified:p.directionVerified,
        eventId:p.captureEventId || (p.id!=null?'legacy:'+p.id:null), siteId:p.siteId, sn:p.sn, assurance:p.assurance,clockIssue:p.clockIssue};
      if (p.directionVerified || (p.trustDirection ?? !legacyDirectionInference)) return { ...evidence, type: deviceDir(p.status) || '' };
      const positional = lone ?? (i === 0 ? "IN" : i === list.length - 1 ? "OUT" : "");
      const device = deviceDir(p.status);
      if (positional && device && device !== positional) {
        corrections.push({
          at: p.punchedAt,
          recordedAs: device,
          resolvedTo: positional,
          reason:
            positional === "IN"
              ? "first scan of the shift, recorded as a check-out"
              : "last scan of the shift, recorded as a check-in",
        });
      }
      return { ...evidence, inferred:true, type: positional || device || "" };
    });

    // HR-ATT-PRIMARY-DEVICE-01 — `punchSn` is the raw device serial per
    // session punch, position-aligned with `punches` (the evaluator's shaped
    // view drops everything but timestamp/type). The writer folds this into
    // Attendance.primary_sn / Attendance.secondary_punches: primary punches
    // are the normal case, punches on any other device are recorded
    // explicitly rather than silently merged.
    out.push({ day: startOfDay(new Date(`${key}T00:00:00Z`)), punches: shaped, corrections, punchSn: list.map((p) => p.sn ?? null) });
  }

  return out;
}

/**
 * Every evaluated shift for one tenant in a window.
 *
 * Assumes the caller has already established the tenant context; it issues
 * ordinary model queries so RLS scopes them.
 */
export async function replayTenant({ tenantId, from, to, policy, now = new Date(), db = prisma,
  employeeIds, includeEmpty = false, runtime: suppliedRuntime, credits = [] }) {
  const windowStart = new Date(+new Date(from+'T00:00:00Z')-DAY_MS);
  const windowEnd = new Date(+new Date(to+'T23:59:59.999Z')+DAY_MS);
  const runtime = suppliedRuntime || await loadAttendanceRuntime({tenantId,from:windowStart,to:windowEnd,db});
  const [punches, excludedRows] = await Promise.all([
    db.attendanceDevicePunch.findMany({
      where:{tenantId,excludedAt:null,employeeId:employeeIds?{in:employeeIds}:{not:null},punchedAt:{gte:windowStart,lte:windowEnd}},
      orderBy:[{employeeId:'asc'},{punchedAt:'asc'}],
    }),
    db.employee.findMany({where:{tenant_id:tenantId,payroll_included:false},select:{id:true}}),
  ]);
  const excluded = new Set(excludedRows.map(e=>e.id)), byEmployee = new Map();
  if(includeEmpty) for(const id of employeeIds || runtime.employeeIds) if(!excluded.has(id))byEmployee.set(id,[]);
  for(const raw of punches) {
    if(excluded.has(raw.employeeId))continue;
    const info=runtime.resolve(raw.employeeId,startOfDay(raw.punchedAt));
    const zone=info.timeZone || 'Asia/Karachi';
    const punchedAt=raw.occurredAt ? civilNow(raw.occurredAt,zone):raw.punchedAt;
    let occurredAt=raw.occurredAt, clockIssue=false;
    try { occurredAt ||= civilInstant(raw.punchedAt,raw.timeZone||zone); }
    catch { clockIssue=true; }
    const p={...raw,punchedAt,occurredAt,clockIssue,trustDirection:(policy||info.policy)?.trustDeviceDirection!==false,
      siteId:raw.siteId || info.deviceSites?.find(d=>d.sn===raw.sn)?.siteId};
    if(!byEmployee.has(p.employeeId))byEmployee.set(p.employeeId,[]);
    byEmployee.get(p.employeeId).push(p);
  }
  const results=[];
  for(const [employeeId,rows] of byEmployee) {
    const patternForDay=day=>runtime.resolve(employeeId,day).pattern;
    const sessions=sessioniseByRoster(rows,patternForDay);
    if(includeEmpty) for(const key of dateRange(from,to)) {
      const day=new Date(key+'T00:00:00Z'), info=runtime.resolve(employeeId,day);
      const windows=info.pattern?.shifts?.length ? shiftCandidates(info.pattern,day):[info.shift||{}];
      for(const window of windows) {
        const found=sessions.some(s=>dayKey(s.day)===key && (!info.pattern?.shifts?.length ||
          +shiftFor(info.pattern,day,s.punches[0]?.timestamp).start===+window.start));
        if(!found)sessions.push({day,punches:[],corrections:[],punchSn:[],anchor:window.start});
      }
    }
    for(const session of sessions) {
      const {day}=session,key=dayKey(day);
      if(key<from||key>to)continue;
      const info=runtime.resolve(employeeId,day,session.anchor||session.punches[0]?.timestamp);
      if(['NOT_ELIGIBLE','MANUAL_MONTHLY'].includes(info.reason))continue;
      const ownCredits=credits.filter(c=>c.employeeId===employeeId&&dayKey(c.date)===key).map(c=>({
        ...c,start:new Date(Math.max(+c.start,+(info.shift?.start||c.start))),
        end:new Date(Math.min(+c.end,+(info.shift?.end||c.end))),
        // Overtime lies outside scheduled hours.
        ...(c.kind==='OVERTIME'?{start:c.start,end:c.end}:{}),
      }));
      let verdict;
      if(info.working && (!info.shift?.start||!info.shift?.end)) {info.working=null;info.reason='MISSING_SHIFT_WINDOW';}
      if(info.working && info.rotating && !session.punches.length) {info.working=null;info.reason='ROTATION_ASSIGNMENT_REQUIRED';}
      if(info.working==null) verdict={status:'SETUP_REQUIRED',dayCredit:null,processingState:'NEEDS_REVIEW',
        requiresRegularization:true,anomalies:[],workedMinutes:0,issues:[{code:info.reason}],intervals:[]};
      else if(!info.working && session.punches.length<2) verdict={
        status:info.reason==='HOLIDAY'?'HOLIDAY':info.reason==='APPROVED_LEAVE'?'ON_LEAVE':'WEEKLY_OFF',
        dayCredit:0,processingState:'FINALIZED',requiresRegularization:false,anomalies:[],workedMinutes:0,intervals:[],issues:[]};
      else {
        verdict=evaluateShift({punches:session.punches,shift:info.shift,policy:policy||info.policy,
          now:civilNow(now,info.timeZone),credits:ownCredits});
        if(info.reason==='PAID_NO_PUNCH')Object.assign(verdict,{status:'PRESENT',dayCredit:1,requiresRegularization:false,
          anomalies:[],processingState:'FINALIZED',issues:[]});
      }
      const siteIssues=evaluateSiteEvidence(session.punches,info,ownCredits);
      if(session.punches.some(p=>p.clockIssue))siteIssues.push({code:"AMBIGUOUS_LEGACY_TIMESTAMP"});
      if(siteIssues.length) Object.assign(verdict,{dayCredit:null,requiresRegularization:true,processingState:'NEEDS_REVIEW',
        issues:[...(verdict.issues||[]),...siteIssues]});
      let deadline=null;
      try { deadline=civilInstant(verdict.deadline,info.timeZone); }
      catch { Object.assign(verdict,{dayCredit:null,processingState:'NEEDS_REVIEW',requiresRegularization:true,
        issues:[...(verdict.issues||[]),{code:'AMBIGUOUS_SHIFT_DEADLINE'}]}); }
      results.push({employeeId,day,sessionKey:info.shift?.start?.toISOString()||key,shift:info.shift,
        deadline,verdict,setupVersion:info.setupVersion,setupSnapshot:info,corrections:session.corrections,
        punchSn:session.punchSn,evidence:session.punches.map(p=>({eventId:p.eventId,sn:p.sn,siteId:p.siteId,
          direction:p.type,inferred:p.inferred===true,at:p.timestamp,occurredAt:p.occurredAt,assurance:p.assurance})),
        credits:ownCredits.map(c=>({id:c.id,kind:c.kind,start:c.start,end:c.end,paid:c.paid,maxMinutes:c.maxMinutes,approvedBy:c.approvedBy}))});
    }
  }
  return capDailyOvertime(results);
}

/** Distinct tenants that have punches. See the note in the scripts: this MUST be
 *  a model query under SYSTEM context — $queryRaw skips the RLS extension, sets
 *  no tenant GUC, and silently returns nothing. */
export async function tenantsWithPunches(mcpCtx) {
  const rows = await mcpCtx.run({ system: true }, async () => {
    return await prisma.attendanceDevicePunch.findMany({
      where: { tenantId: { not: null } },
      distinct: ["tenantId"],
      select: { tenantId: true },
    });
  });
  return rows.map((r) => r.tenantId);
}
