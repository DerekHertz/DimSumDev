// den-mvp/88 (ADR 0027 decisions 6 and 9): the thin runner around decide(). Every part is injected (router.test.mjs's header).
// In memory it keeps only when the bridge first failed to answer, and the stops it pushed but could not record: the record
// is retried each tick, the push never repeats. "The bridge is down" is push-only; when the bridge answers, "it was down for
// N minutes" is recorded. Everything else is read fresh on each tick.
import { decide } from "./decide.mjs";
import { parseOrder } from "./order.mjs";

// A "usage" reading that would let a start or resume go ahead. decide() runs once with it to learn whether anything is due;
// the live reading is read, and decide() run again, only when something is.
const ASSUMED_FINE = { "5-hour": { percent: 0 }, source: "live" };

export function createRouter({ bridge, readOrder, readBoard, readUsage, stops, push, now = Date.now, log = () => {} }) {
  let downSince = null;
  let downPushed = false; // "the bridge has not answered" was pushed this outage; it is recorded when the bridge answers
  const unrecorded = new Map(); // key -> stop: pushed, not yet on the board; the record is retried each tick, the push never

  async function tryRecord(stop) {
    try {
      await stops.record(stop);
      return true;
    } catch (err) {
      log(`could not record the stop ${stop.kind} on the board (${err.message})`);
      return false;
    }
  }

  async function report(stop, known, up) {
    if (known.has(stop.key)) return;
    known.add(stop.key);
    if (stop.kind === "bridge-down") downPushed = true; // push-only: it cannot be recorded through the bridge it reports as down
    else if (!(up && (await tryRecord(stop)))) unrecorded.set(stop.key, stop);
    try {
      await push(stop);
    } catch (err) {
      log(`could not push the stop ${stop.kind} (${err.name})`);
    }
  }

  async function tick() {
    let state = null;
    try {
      state = await bridge.state();
      if (downPushed) {
        const key = `bridge-down:${new Date(downSince).toISOString()}`; // one stop per outage
        unrecorded.set(key, { key, kind: "bridge-down", text: `the bridge was down for ${Math.round((now() - downSince) / 60_000)} minutes` });
        downPushed = false;
      }
      downSince = null;
    } catch {
      downSince ??= now();
    }
    const onBoard = new Set(await stops.known().catch(() => []));
    for (const [key, stop] of unrecorded) {
      if (onBoard.has(key)) unrecorded.delete(key);
      else if (state && (await tryRecord(stop))) {
        unrecorded.delete(key);
        onBoard.add(key);
      }
    }
    const known = new Set([...onBoard, ...unrecorded.keys(), ...(downPushed ? ["bridge-down"] : [])]);
    const up = !!state;
    let order;
    try {
      order = parseOrder(await readOrder());
    } catch (err) {
      await report({ key: `order:${err.message}`, kind: "order", text: `the work order cannot be read: ${err.message}` }, known, up);
      return { failed: true, waiting: "the work order cannot be read" };
    }
    const tickets = await readBoard();
    const downForMs = downSince === null ? 0 : now() - downSince;
    const args = { order, tickets, state, stops: [...known], downForMs };
    let out = decide({ ...args, usage: ASSUMED_FINE });
    if (state && out.actions.length) out = decide({ ...args, usage: await readUsage() });
    for (const s of out.stops) await report(s, known, up);
    let waiting = out.waiting;
    for (const a of out.actions) {
      const reply = a.type === "start" ? await bridge.startDelivery(a.ref) : await bridge.resumeDelivery(a.id);
      if (reply?.ok) continue;
      if (reply?.draining) {
        waiting = "the bridge is draining for an update";
        break;
      }
      const target = a.ref ?? a.id;
      await report({ key: `refused:${a.type}:${target}:${reply?.status}`, kind: `${a.type}-refused`, ...(a.ref ? { ref: a.ref } : {}), text: `the bridge refused to ${a.type} ${target}: ${reply?.status} ${reply?.error ?? ""}`.trim() }, known, up);
    }
    return { actions: out.actions, waiting };
  }

  return { tick };
}
