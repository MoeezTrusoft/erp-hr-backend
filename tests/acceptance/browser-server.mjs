// Loopback-only test transport. Never mounted in the production service.
import http from "node:http";
import { fixture } from "./fixtures.mjs";
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
      row = await f.complete(row);
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
