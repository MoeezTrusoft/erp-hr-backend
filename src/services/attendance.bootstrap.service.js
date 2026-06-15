import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../lib/prisma.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function log(...args) {
  if (String(process.env.ATTENDANCE_DEBUG || "true").toLowerCase() === "false") return;
  console.log("[attendance-bootstrap]", ...args);
}

function findDefaultXlsx(year) {
  const baseDir = path.resolve(__dirname, "../..");
  const files = fs.readdirSync(baseDir).filter((name) => (
    name.startsWith("attendance_all_with_names_") && name.endsWith(".xlsx") && name.includes(String(year))
  ));
  files.sort().reverse();
  return files.length ? path.join(baseDir, files[0]) : null;
}

function runSyncScript({ month, year, input }) {
  return new Promise((resolve, reject) => {
    const args = ["scripts/sync_k20_march_to_db.js", "--month", String(month), "--year", String(year), "--source", "auto"];
    if (input) {
      args.push("--input", input);
    }
    const child = spawn("node", args, {
      cwd: path.resolve(__dirname, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Bootstrap sync failed with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function bootstrapAttendanceData() {
  const enabled = String(process.env.ATTENDANCE_BOOTSTRAP_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    log("Bootstrap disabled");
    return;
  }

  const [employeeCount, attendanceCount] = await Promise.all([
    prisma.employee.count().catch(() => 0),
    prisma.attendance.count().catch(() => 0),
  ]);

  if (attendanceCount > 0) {
    log("Attendance data already present, bootstrap skipped", { employeeCount, attendanceCount });
    return;
  }

  const now = new Date();
  const month = Number(process.env.ATTENDANCE_BOOTSTRAP_MONTH || (now.getMonth() + 1));
  const year = Number(process.env.ATTENDANCE_BOOTSTRAP_YEAR || now.getFullYear());
  const explicitInput = process.env.ATTENDANCE_BOOTSTRAP_XLSX || "";
  const fallbackInput = explicitInput || findDefaultXlsx(year);

  log("Starting initial attendance bootstrap", {
    month,
    year,
    fallbackInput,
  });

  try {
    const result = await runSyncScript({ month, year, input: fallbackInput });
    log("Bootstrap completed", result);
  } catch (err) {
    log("Bootstrap failed", err?.message || err);
  }
}
