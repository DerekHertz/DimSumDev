#!/usr/bin/env node
// organism-infra/111: Claude Code `Notification` and `Stop` hook command. Tells the user when
// the org is waiting on them:
//   Notification  every event raises a toast carrying the event message.
//   Stop          a toast only for gates (tickets at `ready-for-human`) not yet notified; each
//                 gate notifies once, and a gate that cleared and returns counts as new.
// Delivery: a Windows toast through powershell.exe (WSL), else one terminal bell. The message
// travels in an environment variable (never spliced into the PowerShell source), so quotes and
// `$(...)` in it are inert. No model or network call. Always exits 0.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readStdinJson, boardRoot } from "./hook-io.mjs";

const TITLE = "DimSumDev";
const TOAST_TIMEOUT_MS = 10_000;
const READY_FOR_HUMAN = /^\*\*Status:\*\*\s*ready-for-human\s*$/m;

// Windows toast. Title and message come from $env:NOTIFY_TITLE / $env:NOTIFY_MESSAGE and go in
// through CreateTextNode, which takes plain text. The AppId is Windows PowerShell's own, which
// toasts are allowed to use without registering one.
const TOAST_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
  "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$n=$x.GetElementsByTagName('text')",
  "[void]$n.Item(0).AppendChild($x.CreateTextNode($env:NOTIFY_TITLE))",
  "[void]$n.Item(1).AppendChild($x.CreateTextNode($env:NOTIFY_MESSAGE))",
  "$app='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join(";");

function toast(message) {
  const bin = process.env.NOTIFY_POWERSHELL || "powershell.exe";
  const wslenv = [process.env.WSLENV, "NOTIFY_TITLE", "NOTIFY_MESSAGE"].filter(Boolean).join(":");
  try {
    const r = spawnSync(bin, ["-NoProfile", "-NonInteractive", "-Command", TOAST_SCRIPT], {
      env: { ...process.env, NOTIFY_TITLE: TITLE, NOTIFY_MESSAGE: message, WSLENV: wslenv },
      stdio: ["ignore", "ignore", "ignore"],
      timeout: TOAST_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function bell() {
  const target = process.env.NOTIFY_BELL_PATH || "/dev/tty";
  try {
    appendFileSync(target, "\x07");
    return true;
  } catch {
    // no terminal: fall through to stderr
  }
  try {
    process.stderr.write("\x07");
    return true;
  } catch {
    return false;
  }
}

const deliver = (message) => toast(message) || bell();

// Refs of every ticket at ready-for-human, sorted.
function gates(root) {
  const out = [];
  let features = [];
  try {
    features = readdirSync(path.join(root, ".scratch"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const f of features) {
    if (!f.isDirectory()) continue;
    const dir = path.join(root, ".scratch", f.name, "issues");
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      try {
        if (READY_FOR_HUMAN.test(readFileSync(path.join(dir, name), "utf8"))) out.push(`${f.name}/${name.slice(0, -3)}`);
      } catch {
        // ticket vanished mid-read
      }
    }
  }
  return out.sort();
}

const statePath = () => process.env.NOTIFY_STATE || path.join(process.env.HOME || os.homedir(), ".claude", "dimsumden-notify-state.json");

function loadNotified() {
  try {
    const v = JSON.parse(readFileSync(statePath(), "utf8"));
    return Array.isArray(v?.notified) ? v.notified.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveNotified(refs) {
  try {
    mkdirSync(path.dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ notified: refs }));
  } catch {
    // best effort: worst case a gate notifies again
  }
}

const input = readStdinJson();
if (input.hook_event_name === "Notification") {
  deliver(typeof input.message === "string" && input.message ? input.message : "Claude Code needs your attention");
} else if (input.hook_event_name === "Stop") {
  const current = gates(boardRoot());
  const before = loadNotified();
  const fresh = current.filter((ref) => !before.includes(ref));
  // Gates that cleared are dropped, so a re-raised gate is new; an undelivered gate stays new.
  let notified = current.filter((ref) => before.includes(ref));
  if (fresh.length && deliver(`Waiting on you: ${fresh.join(", ")}`)) notified = current;
  saveNotified(notified);
}
