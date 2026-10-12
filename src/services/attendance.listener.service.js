import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBootstrapDeviceEvents,
  ingestListenerHeartbeat,
  ingestRealtimeDeviceEvent,
  updateListenerState,
} from "./attendance.realtime.service.js";
import logger from "../lib/logger.js";

const listenerLog = logger.child({ component: "attendance-listener" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let listenerProcess = null;
let restartTimer = null;
let restartAttempts = 0;
let stdoutBuffer = "";
let manualStopRequested = false;

function debugEnabled() {
  return (
    String(process.env.ATTENDANCE_DEBUG || "true").toLowerCase() !== "false"
  );
}

function log(...args) {
  if (!debugEnabled()) return;
  listenerLog.debug({ args }, "attendance-listener");
}

function parseEnabledFlag(raw) {
  if (raw === undefined) return true;
  return String(raw).toLowerCase() !== "false";
}

function scheduleRestart() {
  if (restartTimer) return;
  const delayMs = Math.min(
    60000,
    Number(process.env.ATTENDANCE_LISTENER_RESTART_MS || 5000) *
      2 ** Math.min(restartAttempts++, 4) +
      Math.random() * 1000,
  );
  log(`Scheduling listener restart in ${delayMs}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startAttendanceListener();
  }, delayMs);
}

const spoolDir =
  process.env.ATTENDANCE_SPOOL_DIR || path.resolve("data/attendance-spool");
let draining = false;
let spoolTimer;
async function drainSpool() {
  if (draining) return;
  draining = true;
  try {
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(spoolDir)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .slice(0, 50)) {
      const file = path.join(spoolDir, name);
      const payload = JSON.parse(readFileSync(file, "utf8"));
      if (payload.type === "bootstrap")
        await ingestBootstrapDeviceEvents(payload.events || []);
      else await ingestRealtimeDeviceEvent(payload);
      unlinkSync(file);
    }
  } catch (err) {
    updateListenerState({ lastError: `Capture spool pending: ${err.message}` });
  } finally {
    draining = false;
  }
}
function handleStdoutChunk(chunk) {
  stdoutBuffer += chunk.toString();
  if (stdoutBuffer.length > 4 * 1024 * 1024) {
    listenerProcess?.kill();
    stdoutBuffer = "";
    updateListenerState({
      lastError: "Device output exceeded its bound; reconnecting for replay",
    });
    return;
  }
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const payload = JSON.parse(line);
      payload.sn = process.env.ATTENDANCE_DEVICE_SN;
      if (payload.type === "bootstrap")
        payload.events = (payload.events || []).map((event) => ({
          ...event,
          sn: payload.sn,
        }));
      if (payload.type === "heartbeat") {
        void ingestListenerHeartbeat(payload).catch((err) =>
          updateListenerState({ lastError: err.message }),
        );
        continue;
      }
      if (payload.type === "listener_status") {
        if (payload.state === "connected") restartAttempts = 0;
        updateListenerState({
          connected: payload.state === "connected",
          lastError: payload.state === "error" ? payload.message : null,
        });
        continue;
      }
      mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
      const file = path.join(spoolDir, `${Date.now()}-${randomUUID()}`);
      writeFileSync(`${file}.tmp`, JSON.stringify(payload), {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      renameSync(`${file}.tmp`, `${file}.json`);
      void drainSpool();
    } catch (err) {
      updateListenerState({
        lastError: `Capture could not be spooled: ${err.message}`,
      });
      listenerProcess?.kill();
    }
  }
}

export function startAttendanceListener() {
  manualStopRequested = false;
  if (!spoolTimer) {
    spoolTimer = setInterval(() => void drainSpool(), 5000);
    spoolTimer.unref();
  }
  void drainSpool();
  const enabled = parseEnabledFlag(process.env.ATTENDANCE_LISTENER_ENABLED);
  updateListenerState({ enabled });
  if (!enabled) {
    log("ATTENDANCE_LISTENER_ENABLED=false, listener not started");
    return;
  }
  if (!process.env.ATTENDANCE_DEVICE_SN) {
    updateListenerState({
      running: false,
      connected: false,
      lastError:
        "Configure a registered ATTENDANCE_DEVICE_SN before starting the listener",
    });
    return;
  }
  if (listenerProcess) {
    log("Listener already running, skipping duplicate start");
    return;
  }

  const pythonBin = process.env.ATTENDANCE_LISTENER_PYTHON || "python3";
  const host = process.env.ATTENDANCE_DEVICE_HOST || "103.245.195.202";
  const port = process.env.ATTENDANCE_DEVICE_PORT || "4370";
  const password = process.env.ATTENDANCE_DEVICE_PASSWORD || "0";
  const timeout = process.env.ATTENDANCE_DEVICE_TIMEOUT || "8";
  const reconnectDelay = process.env.ATTENDANCE_LISTENER_RECONNECT_DELAY || "5";

  const scriptPath = path.resolve(
    __dirname,
    "../../scripts/device_live_listener.py",
  );
  const scriptExists = fs.existsSync(scriptPath);
  log("Boot params:", {
    pythonBin,
    host,
    port,
    timeout,
    reconnectDelay,
    scriptPath,
    scriptExists,
  });

  if (!scriptExists) {
    const msg = `Listener script not found: ${scriptPath}`;
    log(msg);
    updateListenerState({ running: false, connected: false, lastError: msg });
    return;
  }

  const args = [
    scriptPath,
    "--host",
    host,
    "--port",
    String(port),
    "--password",
    String(password),
    "--timeout",
    String(timeout),
    "--reconnect-delay",
    String(reconnectDelay),
  ];

  listenerProcess = spawn(pythonBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  log("Python listener process spawned");

  updateListenerState({
    running: true,
    connected: false,
    lastError: null,
  });

  listenerProcess.stdout.on("data", handleStdoutChunk);
  listenerProcess.stderr.on("data", (chunk) => {
    const errorText = chunk.toString().trim() || "Python stderr error";
    log("Python stderr:", errorText);
    if (errorText.includes("DeprecationWarning")) return;
    updateListenerState({ lastError: errorText });
  });

  listenerProcess.on("error", (err) => {
    log("Python process spawn error:", err?.message || err);
    updateListenerState({
      running: false,
      connected: false,
      lastError: err?.message || "Failed to start python listener",
    });
  });

  listenerProcess.on("close", (code) => {
    log(`Python listener closed with code ${code}`);
    listenerProcess = null;
    updateListenerState({
      running: false,
      connected: false,
      lastError: code === 0 ? null : `Python listener exited with code ${code}`,
    });
    if (
      !manualStopRequested &&
      parseEnabledFlag(process.env.ATTENDANCE_LISTENER_ENABLED)
    ) {
      scheduleRestart();
    } else {
      log("Listener closed after manual stop/shutdown; restart skipped");
    }
  });
}

export function stopAttendanceListener() {
  log("Stopping attendance listener");
  manualStopRequested = true;
  clearInterval(spoolTimer);
  spoolTimer = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (listenerProcess) {
    listenerProcess.kill("SIGTERM");
    listenerProcess = null;
  }
  updateListenerState({ running: false, connected: false });
}
