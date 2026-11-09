// T15 against Postgres: holiday and calendar writes must succeed cleanly (they used to change the data and
// then throw "assignBy is not defined"), refuse past dates the same way on create, update and delete, and
// count "today" in Pakistan time, not UTC.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, people, db, as } from "../approval/fixtures.mjs";
import {
  createHoliday, updateHoliday, deleteHoliday, updateHolidayCalendar, createHolidayCalendar, updateRegion,
} from "../../src/services/holiday.service.js";

let ready;
const ensure = () => (ready ||= setup());
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 86400000);

test("update and delete holiday / update calendar succeed and report success", { timeout: 120000 }, async () => {
  await ensure();
  const cal = await db((tx) => tx.holidayCalendar.create({ data: { tenantId: company, name: `Cal-${Date.now()}`, createdById: people.HR.id } }));
  const date = iso(addDays(40));

  const created = await as("HR", () => createHoliday({ holidayCalendarId: cal.id, name: "Founders day", date }, people.HR.id));
  assert.equal(iso(created.date), date);

  // These used to write and then throw ReferenceError: assignBy is not defined.
  const updated = await as("HR", () => updateHoliday(cal.id, date, { name: "Founders day (moved)" }, people.HR.id));
  assert.equal(updated.name, "Founders day (moved)");

  const calUpdated = await as("HR", () => updateHolidayCalendar(cal.id, { description: "2027" }, people.HR.id));
  assert.equal(calUpdated.description, "2027");

  const deleted = await as("HR", () => deleteHoliday(cal.id, date, people.HR.id));
  assert.equal(iso(deleted.date), date);
  assert.equal(await db((tx) => tx.holiday.count({ where: { holidayCalendarId: cal.id } })), 0);

  // Deleting again is a clean "not found", not a crash.
  await assert.rejects(() => as("HR", () => deleteHoliday(cal.id, date, people.HR.id)), /not found/i);
});

test("past dates are refused on create, update (old and new date) and delete", { timeout: 120000 }, async () => {
  await ensure();
  const cal = await db((tx) => tx.holidayCalendar.create({ data: { tenantId: company, name: `Past-${Date.now()}`, createdById: people.HR.id } }));
  const past = iso(addDays(-10)), future = iso(addDays(30));
  await assert.rejects(() => as("HR", () => createHoliday({ holidayCalendarId: cal.id, name: "old", date: past }, people.HR.id)), /past/i);

  // A past holiday that already exists (history) cannot be edited, moved or deleted.
  await db((tx) => tx.holiday.create({ data: { tenantId: company, holidayCalendarId: cal.id, name: "Past one", date: new Date(past), createdById: people.HR.id } }));
  await assert.rejects(() => as("HR", () => updateHoliday(cal.id, past, { name: "rewrite history" }, people.HR.id)), /past/i);
  await assert.rejects(() => as("HR", () => deleteHoliday(cal.id, past, people.HR.id)), /past/i);
  assert.equal((await db((tx) => tx.holiday.findFirst({ where: { holidayCalendarId: cal.id, name: "Past one" } }))).name, "Past one");

  // A future holiday cannot be moved INTO the past.
  await as("HR", () => createHoliday({ holidayCalendarId: cal.id, name: "Future", date: future }, people.HR.id));
  await assert.rejects(() => as("HR", () => updateHoliday(cal.id, future, { date: past }, people.HR.id)), /past/i);
  assert.equal(await db((tx) => tx.holiday.count({ where: { holidayCalendarId: cal.id, name: "Future" } })), 1);
});

test("a holiday is allowed today and refused yesterday, counted in Pakistan time", { timeout: 120000 }, async () => {
  await ensure();
  const cal = await db((tx) => tx.holidayCalendar.create({ data: { tenantId: company, name: `Today-${Date.now()}`, createdById: people.HR.id } }));
  const pktToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const pktYesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(addDays(-1));
  const ok = await as("HR", () => createHoliday({ holidayCalendarId: cal.id, name: "Today", date: pktToday }, people.HR.id));
  assert.equal(iso(ok.date), pktToday);
  await assert.rejects(() => as("HR", () => createHoliday({ holidayCalendarId: cal.id, name: "Yesterday", date: pktYesterday }, people.HR.id)), /past/i);
});

test("calendar create/update and region update report success", { timeout: 120000 }, async () => {
  await ensure();
  const cal = await as("HR", () => createHolidayCalendar({ name: `New-${Date.now()}`, description: "d" }, people.HR.id));
  assert.ok(cal.id);
  const region = await db((tx) => tx.region.create({ data: { tenantId: company, name: `R-${Date.now()}`, code: `R${Date.now() % 100000}`, createdById: people.HR.id } }));
  const r = await as("HR", () => updateRegion(region.id, people.HR.id, { description: "updated" }));
  assert.equal(r.description, "updated");
});
