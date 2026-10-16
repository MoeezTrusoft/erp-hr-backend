// Loopback-only test transport. Never mounted in the production service.
import http from "node:http";
import { fixture } from "./fixtures.mjs";
import { hash, seal, unseal } from "../../src/services/company-setup/base.js";
const f = await fixture();
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/health") {
      res.end("{}");
      return;
    }
    if (path === "/fixture") {
      res.end(
        JSON.stringify({
          setup: f.setup,
          codes: Object.fromEntries(
            Object.entries(f.people).map(([k, e]) => [k, e.employee_code]),
          ),
          sn: f.sn,
        }),
      );
      return;
    }
    if (path === "/prepare-complete") {
      let row = (await f.call("EMP", "read", { slot: "S01" })).record;
      // Native database tests execute every individual result command. Seed the
      // remaining witnessed-result fixture in one transaction here so browser
      // coverage can focus on forms, evidence, defects and independent reviews.
      await f.db(async (tx) => {
        const stored = await tx.attendanceAcceptanceSite.findFirst({
          where: { id: row.siteRef },
        });
        const data = unseal(stored.payload);
        for (const t of row.runs)
          data.runs[t.runKey] = {
            runKey: t.runKey,
            outcome: t.allowNA ? "NA" : "PASS",
            observed: t.allowNA
              ? "This device family is outside the approved scope"
              : "Controlled synthetic fixture: expected result observed",
            startedAt: "2020-01-01T08:00:00.000Z",
            finishedAt: "2020-01-01T08:05:00.000Z",
            witnessCode: f.people.MANAGER.employee_code,
            testerCode: f.people.EMP.employee_code,
            attempts: 300,
            metrics:
              "Synthetic fixture: 300/300 transactions reconciled; zero wrong identities",
            deviations: "",
            evidenceRefs: ["controlled:synthetic-ledger"],
            attachmentRefs: [],
            defectRefs: [],
            recordedAt: new Date().toISOString(),
          };
        const contentHash = hash(data);
        const updated = await tx.attendanceAcceptanceSite.update({
          where: { id: stored.id },
          data: { payload: seal(data), contentHash, version: { increment: 1 } },
        });
        await tx.attendanceAcceptanceAudit.create({
          data: {
            tenantId: f.tenantId,
            siteRef: stored.id,
            version: updated.version,
            action: "TEST_FIXTURE_RESULTS",
            actorCode: f.people.EMP.employee_code,
            actorUserId: f.people.EMP.userId,
            payload: seal({
              reason: "Isolated browser fixture only",
              contentHash,
              state: updated.state,
              snapshot: data,
            }),
          },
        });
      });
      row = (await f.call("EMP", "read", { slot: "S01" })).record;
      res.end(JSON.stringify(row));
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const rpc = JSON.parse(body),
      op = rpc.name.replace("hr_attendance_acceptance_", "");
    const value = await f.call(
      req.headers["x-test-role"] || "EMP",
      op,
      rpc.input,
    );
    res.end(JSON.stringify(value));
  } catch (e) {
    res.statusCode = e.status || 422;
    res.end(JSON.stringify({ error: e.message }));
  }
});
server.listen(5397, "127.0.0.1");
