// den-mvp/88 (ADR 0027 decisions 6 and 9): the thin runner around decide(). Every part is injected (router.test.mjs's header).
// In memory it keeps only when the bridge first failed to answer, and the stops it pushed but could not record: the record
// is retried each tick, the push never repeats. "The bridge is down" is push-only; when the bridge answers, "it was down for
// N minutes" is recorded. Everything else is read fresh on each tick.
import { decide, LOOK_INTERVAL_MS, LOOK_KINDS } from "./decide.mjs";
import { parseOrder } from "./order.mjs";
import { hasSecret } from "../../scripts/exposure.mjs";

// A "usage" reading that would let a start or resume go ahead. decide() runs once with it to learn whether anything is due;
// the live reading is read, and decide() run again, only when something is.
const ASSUMED_FINE = { "5-hour": { percent: 0 }, source: "live" };

export function createRouter({ bridge, readOrder, readBoard, readUsage, readChanged = async () => new Map(), stops, push, now = Date.now, log = () => {} }) {
  let downSince = null;
  let sweptAt = -Infinity; // when the router last asked the bridge to sweep for work merged outside a delivery
  const looked = new Map(); // delivery id -> when the router last looked at its guardrail or ci-pending pause (den-mvp/106)
  const looks = new Map(); // delivery id -> how many looks, so checks that never finish are reported
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

  // The bridge refuses a key over 300 or a text over 500 characters (400), which would be retried every tick, so both are cut here.
  const cut = (stop) => ({ ...stop, key: stop.key.slice(0, 300), text: stop.text.slice(0, 500) });
  async function report(raw, known, up) {
    const found = cut(raw);
    if (known.has(found.key)) return;
    // Stop text goes to the board and to ntfy, off the box: a secret-looking line is replaced, never sent (88 security).
    const stop = hasSecret(found.text) ? { ...found, text: `a ${found.kind} stop whose text looked like a secret; see the router's log` } : found;
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
    // A failed read only costs pairing: each delivery then holds the files its ticket names.
    const changed = state ? await readChanged(state.deliveries ?? []).catch(() => new Map()) : new Map();
    const args = { order, tickets, state, stops: [...known], downForMs, changed, looked, looks, nowMs: now() };
    // A delivery that ended or paused for another reason starts its count again.
    for (const id of looks.keys()) {
      const d = (state?.deliveries ?? []).find((x) => x.id === id);
      if (!d || !(d.state === "running" || LOOK_KINDS.has(d.pause?.kind))) looks.delete(id);
    }
    let out = decide({ ...args, usage: ASSUMED_FINE });
    if (state && out.actions.length) out = decide({ ...args, usage: await readUsage() });
    for (const s of out.stops) await report(s, known, up);
    let waiting = out.waiting;
    for (const a of out.actions) {
      if (a.type === "resume") {
        looked.set(a.id, now());
        looks.set(a.id, (looks.get(a.id) ?? 0) + 1);
      }
      const reply = a.type === "start" ? await bridge.startDelivery(a.ref) : await bridge.resumeDelivery(a.id);
      if (reply?.ok) continue;
      if (reply?.draining) {
        waiting = "the bridge is draining for an update";
        break;
      }
      const target = a.ref ?? a.id;
      await report({ key: `refused:${a.type}:${target}:${reply?.status}`, kind: `${a.type}-refused`, ...(a.ref ? { ref: a.ref } : {}), text: `the bridge refused to ${a.type} ${target}: ${reply?.status} ${reply?.error ?? ""}`.trim() }, known, up);
    }
    // den-mvp/106: work merged outside a delivery is resolved by the bridge; asked at most once per look interval.
    if (state && typeof bridge.sweep === "function" && now() - sweptAt >= LOOK_INTERVAL_MS) {
      sweptAt = now();
      await bridge.sweep().catch((err) => log(`the sweep failed (${err.message})`));
    }
    return { actions: out.actions, waiting };
  }

  return { tick };
}
