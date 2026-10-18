// den-mvp/88 (ADR 0027 decisions 6 and 9): the thin runner around decide(). Every part is injected (router.test.mjs's header).
// In memory it keeps only when the bridge first failed to answer, and the stops it pushed but could not record (the bridge
// was down), so they are not pushed again by this process. Everything else is read fresh on each tick.
import { decide } from "./decide.mjs";
import { parseOrder } from "./order.mjs";

export function createRouter({ bridge, readOrder, readBoard, readUsage, stops, push, now = Date.now, log = () => {} }) {
  let downSince = null;
  const unrecorded = new Set();

  async function report(stop, known) {
    if (known.has(stop.key) || unrecorded.has(stop.key)) return;
    known.add(stop.key);
    try {
      await stops.record(stop);
    } catch (err) {
      unrecorded.add(stop.key);
      log(`could not record the stop ${stop.kind} on the board (${err.message})`);
    }
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
      downSince = null;
      unrecorded.delete("bridge-down"); // a later outage is reported again
    } catch {
      downSince ??= now();
    }
    const known = new Set(await stops.known().catch(() => []));
    let order;
    try {
      order = parseOrder(await readOrder());
    } catch (err) {
      await report({ key: `order:${err.message}`, kind: "order", text: `the work order cannot be read: ${err.message}` }, known);
      return { failed: true, waiting: "the work order cannot be read" };
    }
    const [tickets, usage] = await Promise.all([readBoard(), state ? readUsage() : null]);
    const out = decide({ order, tickets, state, usage, stops: [...known], downForMs: downSince === null ? 0 : now() - downSince });
    for (const s of out.stops) await report(s, known);
    let waiting = out.waiting;
    for (const a of out.actions) {
      const reply = a.type === "start" ? await bridge.startDelivery(a.ref) : await bridge.resumeDelivery(a.id);
      if (reply?.ok) continue;
      if (reply?.draining) {
        waiting = "the bridge is draining for an update";
        break;
      }
      const target = a.ref ?? a.id;
      await report({ key: `refused:${a.type}:${target}:${reply?.status}`, kind: `${a.type}-refused`, ...(a.ref ? { ref: a.ref } : {}), text: `the bridge refused to ${a.type} ${target}: ${reply?.status} ${reply?.error ?? ""}`.trim() }, known);
    }
    return { actions: out.actions, waiting };
  }

  return { tick };
}
