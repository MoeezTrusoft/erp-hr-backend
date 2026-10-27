import test from "node:test";
import assert from "node:assert/strict";
import { interviewCalendarFile } from "../../src/lib/interviewCalendarFile.js";
const row={id:11,tenantId:"00000000-0000-4000-8000-000000000001",scheduledAt:"2030-01-07T04:00:00Z",updated_at:"2030-01-02T10:00:00Z",durationMinutes:60,sequence:0,status:"SCHEDULED",jobTitle:"اردو کام ".repeat(20),location:"Room, 2; office\\west\r\nATTENDEE:intruder@example.invalid"};
test("calendar export preserves Unicode, folds UTF-8 lines and escapes untrusted content",()=>{
 const result=interviewCalendarFile(row),lines=result.split("\r\n");
 assert.ok(lines.every(line=>Buffer.byteLength(line)<=75));
 const unfolded=result.replace(/\r\n /g,"");
 assert.ok(unfolded.includes("SUMMARY:Interview: "+row.jobTitle));
 assert.ok(unfolded.includes("DTEND:20300107T050000Z"));
 assert.ok(!lines.some(line=>line.startsWith("ATTENDEE:")));
 assert.ok(unfolded.includes("Room\\, 2\\; office\\\\west\\nATTENDEE:"));
 assert.ok(!unfolded.includes("METHOD:"));
});
test("reschedule and cancellation retain UID while advancing the sequence",()=>{
 const original=interviewCalendarFile(row),updated=interviewCalendarFile({...row,scheduledAt:"2030-01-08T04:00:00Z",status:"CANCELLED",sequence:2});
 assert.equal(original.match(/UID:(.*)/)[1],updated.match(/UID:(.*)/)[1]);
 assert.ok(updated.includes("SEQUENCE:2"));assert.ok(updated.includes("STATUS:CANCELLED"));
 assert.notEqual(interviewCalendarFile({...row,tenantId:"00000000-0000-4000-8000-000000000002"}).match(/UID:(.*)/)[1],original.match(/UID:(.*)/)[1]);
});
