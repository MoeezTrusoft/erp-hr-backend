// Source owners export versioned WorkEvidenceEvent NDJSON. No historical score imports.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {setTimeout as wait} from 'node:timers/promises';
import {WorkEvidenceEvent} from '@trusoft/contracts/assessment';
const flag=name=>process.argv[process.argv.indexOf(name)+1];
if(!process.argv.includes('--file')||!process.argv.includes('--company'))throw new Error('Use --file events.ndjson --company company-uuid; default validates only. --apply requires gateway URL and short-lived token in ASSESSMENT_GATEWAY_URL / ASSESSMENT_ACCESS_TOKEN.');
const company=flag('--company'),apply=process.argv.includes('--apply');
const endpoint=apply?new URL(process.env.ASSESSMENT_GATEWAY_URL):null;
if(apply&&(!process.env.ASSESSMENT_ACCESS_TOKEN||endpoint.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(endpoint.hostname)))throw new Error('Use an HTTPS gateway and authenticated source-owner token');
const rows=createInterface({input:createReadStream(flag('--file')),crlfDelay:Infinity});
let count=0;
for await(const line of rows){
  if(!line.trim())continue;
  const e=WorkEvidenceEvent.parse(JSON.parse(line));
  if(e.companyUuid!==company)throw new Error(`Row ${count+1}: company mismatch`);
  if(Date.parse(e.occurredAt)<Date.now()-366*86400000||Date.parse(e.occurredAt)>Date.now()+60000)throw new Error(`Row ${count+1}: outside the permitted twelve-month backfill window`);
  if(apply){
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${process.env.ASSESSMENT_ACCESS_TOKEN}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++count,method:'tools/call',params:{name:'hr_assessment_evidence_ingest',arguments:e}}),signal:AbortSignal.timeout(30000)});
    const text=await response.text();
    const body=JSON.parse(text.startsWith('data:')?text.split('\n').filter(l=>l.startsWith('data:')).at(-1).slice(5):text);
    if(!response.ok||body.error||body.result?.isError)throw new Error(`Backfill stopped at row ${count}; source rejected the event. Re-run after correction; event IDs prevent duplicates.`);
    await wait(250);
  }else count++;
}
console.log(JSON.stringify({company,validated:count,queued:apply?count:0,applied:apply}));
