// den-mvp/88 (ADR 0027): the router's process, run by den-router.service from the copy `den:install` made outside every
// release. Working directory: the checkout (the board and the work order are read there; usage.mjs runs from the router's own copy).
//   DEN_STATE_DIR   the den's state folder (service-token, ntfy-url)     PORT  the bridge's port (4317)
//   DEN_ORDER_FILE  the work order (default <checkout>/.scratch/work-order.md)
// It ticks at start, after GET /events changes (at most once a minute) and every five minutes, one tick at a time.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultReadBoard } from "../../scripts/batch-groups.mjs";
import { cachedReading, createBridgeClient, pushNtfy, readChangedFiles, readKnownStops, readLiveUsage } from "./client.mjs";
import { createRouter } from "./router.mjs";
import { readServiceToken } from "./service-token.mjs";

const MIN_GAP_MS = 60_000;
const EVERY_MS = 5 * 60_000;
const USAGE_TTL_MS = 3 * 60_000; // the live usage API is not read more often, and a 429 or cooldown reading (an error) holds for as long
const root = process.cwd();
const stateDir = process.env.DEN_STATE_DIR;
if (!stateDir || !path.isAbsolute(stateDir)) {
  console.error("den-router: DEN_STATE_DIR must name the den's state folder");
  process.exit(1);
}
const token = await readServiceToken(stateDir);
if (!token) {
  console.error("den-router: no service token in the state folder; run npm run den:install");
  process.exit(1);
}
const ntfyUrl = (await readFile(path.join(stateDir, "ntfy-url"), "utf8").catch(() => "")).trim();
const orderFile = process.env.DEN_ORDER_FILE || path.join(root, ".scratch", "work-order.md");
const bridge = createBridgeClient({ url: `http://127.0.0.1:${Number(process.env.PORT) || 4317}`, token });

const router = createRouter({
  bridge,
  readOrder: () => readFile(orderFile, "utf8"),
  readBoard: async () => defaultReadBoard(),
  readUsage: cachedReading(() => readLiveUsage(), { ttlMs: USAGE_TTL_MS }),
  readChanged: (deliveries) => readChangedFiles(root, deliveries),
  stops: {
    known: () => readKnownStops(root),
    record: async (stop) => {
      const out = await bridge.recordStop(stop);
      if (!out.ok) throw new Error(`POST /router-stops answered ${out.status}`);
    },
  },
  push: (stop) => pushNtfy(ntfyUrl, stop),
  log: (line) => console.log(`den-router: ${line}`),
});

let running = false;
let again = false;
let last = 0;
let timer = null;
async function tick() {
  if (running) return void (again = true);
  running = true;
  last = Date.now();
  try {
    const out = await router.tick();
    if (out?.actions?.length) console.log(`den-router: ${out.actions.map((a) => `${a.type} ${a.ref ?? a.id}`).join(", ")}`);
  } catch (err) {
    console.error(`den-router: tick failed: ${err.message}`);
  } finally {
    running = false;
    if (again) {
      again = false;
      soon();
    }
  }
}
function soon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    tick();
  }, Math.max(0, last + MIN_GAP_MS - Date.now()));
}
function follow() {
  bridge.events(soon, () => setTimeout(follow, 30_000));
}

setInterval(tick, EVERY_MS);
follow();
tick();
