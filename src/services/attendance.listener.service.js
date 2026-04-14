import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBootstrapDeviceEvents,
  ingestRealtimeDeviceEvent,
  persistBootstrapPunches,
  updateListenerState,
} from "./attendance.realtime.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let listenerProcess = null;
let restartTimer = null;
let stdoutBuffer = "";
let manualStopRequested = false;

function debugEnabled() {
  return String(process.env.ATTENDANCE_DEBUG || "true").toLowerCase() !== "false";
}

function log(...args) {
  if (!debugEnabled()) return;
  console.log("[attendance-listener]", ...args);
}

function parseEnabledFlag(raw) {
  if (raw === undefined) return true;
  return String(raw).toLowerCase() !== "false";
}

function scheduleRestart() {
  if (restartTimer) return;
  const delayMs = Number(process.env.ATTENDANCE_LISTENER_RESTART_MS || 5000);
  log(`Scheduling listener restart in ${delayMs}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startAttendanceListener();
  }, delayMs);
}

function handleStdoutChunk(chunk) {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("{")) {
      log("Python stdout (non-json):", trimmed);
      continue;
    }
    try {
      const payload = JSON.parse(trimmed);
      if (payload?.type === "listener_status") {
        log("Python status:", payload);
        if (payload.state === "connected") {
          updateListenerState({
            running: true,
            connected: true,
            lastError: null,
          });
        } else if (payload.state === "warning") {
          log("Python warning:", payload.message);
        } else if (payload.state === "error") {
          updateListenerState({
            connected: false,
            lastError: payload.message || "Python listener error",
          });
        }
        continue;
      }

      if (payload?.type === "bootstrap") {
        const events = payload.events || [];
        ingestBootstrapDeviceEvents(events).catch((err) => {
          log("Bootstrap UI ingest error:", err?.message || err);
        });
        persistBootstrapPunches(events).catch((err) => {
          log("Bootstrap DB sync error:", err?.message || err);
        });
        continue;
      }

      ingestRealtimeDeviceEvent(payload).catch((err) => {
        log("Realtime ingest error:", err?.message || err);
        updateListenerState({ lastError: err?.message || "Realtime ingest failed" });
      });
    } catch {
      log("Invalid JSON from python stdout line:", trimmed);
    }
  }
}

export function startAttendanceListener() {
  manualStopRequested = false;
  const enabled = parseEnabledFlag(process.env.ATTENDANCE_LISTENER_ENABLED);
  updateListenerState({ enabled });
  if (!enabled) {
    log("ATTENDANCE_LISTENER_ENABLED=false, listener not started");
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

  const scriptPath = path.resolve(__dirname, "../../scripts/device_live_listener.py");
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
    "--host", host,
    "--port", String(port),
    "--password", String(password),
    "--timeout", String(timeout),
    "--reconnect-delay", String(reconnectDelay),
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
    if (!manualStopRequested && parseEnabledFlag(process.env.ATTENDANCE_LISTENER_ENABLED)) {
      scheduleRestart();
    } else {
      log("Listener closed after manual stop/shutdown; restart skipped");
    }
  });
}

export function stopAttendanceListener() {
  log("Stopping attendance listener");
  manualStopRequested = true;
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
