// Duration-specific late/early rules. Attendance facts stay unchanged in storage.
const day = value => new Date(value).toISOString().slice(0,10);
const types = {LATE:'LATE_CHECKIN',EARLY_CHECKOUT:'EARLY_CHECKOUT'};
const nonworking = new Set(['WEEKLY_OFF','HOLIDAY','ON_LEAVE']);
function recordedIncident(row, anomalies, type) {
 const matchingStatus = type==='LATE_CHECKIN' ? row.status==='LATE' : row.status==='EARLY_CHECKOUT';
 // One daily status can describe only one side of a shift. Preserve a second
 // measured timing violation on that shift without reclassifying PRESENT days.
 const secondIncident = ['LATE','EARLY_CHECKOUT'].includes(row.status) && Number(row[type==='LATE_CHECKIN'?'lateMinutes':'earlyMinutes'])>0;
 return matchingStatus || secondIncident || row.status==='HALF_DAY' || anomalies.some(a=>a.date && day(a.date)===day(row.date) && a.type===type && a.status!=='APPROVED');
}
export const isTimingRule = r => Boolean(r?.enabled && types[r.ruleKey] && r.durationThresholdMinutes != null && r.overThresholdDeductionDays != null);
export function timingViolationDays({attendance=[],anomalies=[],rules=[]}) {
 const result=new Map();
 for(const row of attendance) {
  if(row.manually_corrected || nonworking.has(row.status)) continue;
  const key=day(row.date);
  if(anomalies.some(a=>day(a.date)===key && a.manualDeductionDays!=null)) continue;
  for(const rule of rules.filter(isTimingRule)) {
   const type=types[rule.ruleKey];
   if(anomalies.some(a=>day(a.date)===key && a.status==='APPROVED')) continue;
   const minutes=row[rule.ruleKey==='LATE'?'lateMinutes':'earlyMinutes'];
   const expected=recordedIncident(row,anomalies,type);
   // Price recorded incidents; do not reclassify PRESENT days from raw punches.
   if(!expected) continue;
   if(minutes==null && expected) throw new Error(`Timing evidence missing for ${type} on ${key}; check the roster and punches before payroll`);
   if(minutes!=null && Number.isFinite(Number(minutes)) && Number(minutes)>0) result.set(`${rule.ruleKey}|${key}`,{ruleKey:rule.ruleKey,day:key,minutes:Number(minutes)});
  }
 }
 return [...result.values()].sort((a,b)=>a.day.localeCompare(b.day)||a.ruleKey.localeCompare(b.ruleKey));
}
export function computeTimingDeductions({violations=[],rules=[]}) {
 const groups=new Map();
 for(const r of rules.filter(isTimingRule)) {
  const group=r.counterGroup||r.ruleKey;
  if(!groups.has(group)) groups.set(group,{rule:r,short:new Set(),long:new Set()});
  const pool=groups.get(group);
  for(const key of ['triggerCount','deductionDays','durationThresholdMinutes','overThresholdDeductionDays','maxDeductionDaysPerPeriod']) if(pool.rule[key]!==r[key]) throw new Error(`Inconsistent timing rules in ${group}`);
  for(const v of violations.filter(v=>v.ruleKey===r.ruleKey)) {
   if(!Number.isFinite(v.minutes) || v.minutes<=0) throw new Error('Timing violation must have positive minutes');
   (v.minutes>r.durationThresholdMinutes?pool.long:pool.short).add(`${v.ruleKey}|${v.day}`);
  }
 }
 const lines=[];
 for(const [group,{rule:r,short,long}] of groups) {
  let remaining=r.maxDeductionDaysPerPeriod??Infinity;
  for(const [occurrences,days,label] of [[long.size,long.size*r.overThresholdDeductionDays,`Late/early over ${r.durationThresholdMinutes} minutes`],[short.size,Math.floor(short.size/Math.max(1,r.triggerCount))*r.deductionDays,`Late/early within ${r.durationThresholdMinutes} minutes (combined)`]]) {
   const charged=Math.min(days,remaining);remaining-=charged;
   if(charged>0) lines.push({ruleKey:r.ruleKey,counterGroup:group,label,occurrences,days:charged,rawDays:charged});
  }
 }
 return lines;
}
export function normalizeTimingCredits(attendance=[],rules=[],anomalies=[]) {
 const late=rules.some(r=>isTimingRule(r)&&r.ruleKey==='LATE'),early=rules.some(r=>isTimingRule(r)&&r.ruleKey==='EARLY_CHECKOUT');
 return attendance.map(row=>!row.manually_corrected && !nonworking.has(row.status) && row.day_credit!=null && ((late&&row.lateMinutes>0&&recordedIncident(row,anomalies,'LATE_CHECKIN'))||(early&&row.earlyMinutes>0&&recordedIncident(row,anomalies,'EARLY_CHECKOUT'))) ? {...row,day_credit:1} : row);
}
