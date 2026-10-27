import {describe,it,expect} from '@jest/globals';
import {attendanceViewMatches,shiftKey} from '../../src/lib/attendanceViewFilters.js';
import {completeTimesheetRows} from '../../src/lib/timesheetRows.js';
describe('published attendance scope filters',()=>{
  it('requires every selected site, department and shift to match the dated assignment',()=>{
    const info={departmentId:12,siteAssignment:{siteIds:['HO']},shift:{start:new Date('2026-10-12T20:00:00Z'),end:new Date('2026-10-13T05:00:00Z')}};
    expect(shiftKey(info.shift)).toBe('20:00–05:00');
    expect(attendanceViewMatches(info,{department:'12',site:'HO',shift:'20:00–05:00'})).toBe(true);
    expect(attendanceViewMatches(info,{department:'13'})).toBe(false);
    expect(attendanceViewMatches(info,{site:'OTHER'})).toBe(false);
    expect(attendanceViewMatches({}, {site:'HO'})).toBe(false);
  });
  it('projects all 550 employee days across seven sites without treating missing capture as absence',()=>{
    const employees=Array.from({length:550},(_,i)=>({id:i+1,employee_code:`EMP-${String(i+1).padStart(5,'0')}`}));
    const runtime={resolve:(id,day)=>({working:true,timeZone:'Asia/Karachi',departmentId:1,siteAssignment:{siteIds:['SITE-'+id%7]},sites:[{id:'SITE-'+id%7,name:'Synthetic site'}],shift:{start:new Date(`${new Date(day).toISOString().slice(0,10)}T09:00:00Z`),end:new Date(`${new Date(day).toISOString().slice(0,10)}T17:00:00Z`)}})};
    const args={employees,runtime,records:[],anomalies:[],from:'2026-10-01',to:'2026-10-31',now:new Date('2026-11-01')};
    const rows=completeTimesheetRows(args);
    expect(rows).toHaveLength(17050);
    expect(rows.every(r=>r.status==='PENDING_ATTENDANCE'&&r.total_hours===null)).toBe(true);
    const site=completeTimesheetRows({...args,filters:{site:'SITE-0'}});
    expect(site).toHaveLength(employees.filter(e=>e.id%7===0).length*31);
  });
});
