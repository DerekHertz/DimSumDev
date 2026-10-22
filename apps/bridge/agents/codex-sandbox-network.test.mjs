// den-revival/01, ADR 0030 test 3: under the real launch plan, a connection to an owned localhost listener is refused. The
// listener counts what it saw, the only proof of a refusal (a timeout proves nothing). No model or account call. Skips, with its
// reason, on a host that cannot run the plan.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { codexSandboxHost, countingListener, describeRun, makeFixture, touch, dropSlice } from "./codex-sandbox-test-helpers.mjs";

after(dropSlice);

const PROBE = `import fs from "node:fs";
import net from "node:net";
const out = (v) => fs.writeSync(1, JSON.stringify(v) + "\\n");
const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[2]) });
let finished = false;
const done = (outcome) => { if (finished) return; finished = true; socket.destroy(); out({ outcome }); };
socket.setTimeout(3000, () => done("timeout"));
socket.once("connect", () => done("connected"));
socket.once("error", (e) => done(e.code ?? "error"));
`;
const REFUSALS = ["EACCES", "EPERM", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED"];

test("a connection to an owned localhost listener is refused and the listener sees none", async (t) => {
  const host = await codexSandboxHost();
  if (host.skip) return t.skip(host.skip);
  const listener = await countingListener();
  const fixture = await makeFixture(host).catch(async (err) => { await listener.close(); throw err; });
  try {
    await touch(listener.port); // control: the listener does count an allowed connection
    assert.equal(listener.connections(), 1, "the control connection from the host was not counted, so a zero below would mean nothing");
    listener.reset();
    const r = await fixture.run(PROBE, [String(listener.port)]);
    assert.equal(listener.connections(), 0, `the listener saw ${listener.connections()} connection(s) from inside the sandbox\n${describeRun(r)}`);
    let reported;
    try { reported = JSON.parse(r.stdout).outcome; } catch {}
    assert.ok(REFUSALS.includes(reported), `the probe must report a refusal (${REFUSALS.join("/")}), not a timeout or a missing report; got ${JSON.stringify(reported)}\n${describeRun(r)}`);
  } finally {
    await fixture.dispose();
    await listener.close();
  }
});
