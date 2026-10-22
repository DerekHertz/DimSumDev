// hardening/11 fix round: reason phrases, the upstream dial timeout and the tunnel idle timeout (short injected values).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { startProxies } from "./proxy.mjs";

const GRANTED = "granted.test";
const echoServer = () => net.createServer((s) => { s.on("data", (d) => s.write(d)); s.on("error", () => {}); });
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Send a CONNECT; resolve the raw status line and the socket.
function connectRaw(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    socket.on("error", reject);
    socket.on("data", function onData(d) {
      buf += d.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ line: buf.split("\r\n")[0], socket });
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe("proxy limits", () => {
  const toClose = [];
  after(async () => { for (const c of toClose) await c(); });
  const start = async (over) => {
    const fleet = await startProxies({ roles: { developer: [GRANTED] }, basePort: 0, listenHost: "127.0.0.1", tokenSource: { get: async () => "t" }, log: () => {}, ...over });
    toClose.push(() => fleet.close());
    return fleet;
  };

  test("a refusal and a dial failure carry the right reason phrase", async () => {
    const fleet = await start({ dial: () => { throw new Error("nope"); } });
    const refused = await connectRaw(fleet.ports.developer, "other.test:443");
    assert.equal(refused.line, "HTTP/1.1 403 Forbidden");
    const failed = await connectRaw(fleet.ports.developer, `${GRANTED}:443`);
    assert.equal(failed.line, "HTTP/1.1 502 Bad Gateway");
    refused.socket.destroy();
    failed.socket.destroy();
  });

  test("a dial that never connects is cut off after the dial timeout with a 504 and the socket destroyed", async () => {
    let destroyed = false;
    const hung = Object.assign(new EventEmitter(), { connecting: true, destroy() { destroyed = true; } });
    const fleet = await start({ dial: () => hung, dialTimeoutMs: 100 });
    const r = await connectRaw(fleet.ports.developer, `${GRANTED}:443`);
    assert.equal(r.line, "HTTP/1.1 504 Gateway Timeout");
    assert.equal(destroyed, true);
    r.socket.destroy();
  });

  test("an idle tunnel is closed after the idle timeout; a busy one is not", async () => {
    const echo = echoServer();
    const echoPort = await listen(echo);
    toClose.push(() => new Promise((r) => { echo.close(r); echo.closeAllConnections?.(); }));
    const fleet = await start({ dial: () => net.connect(echoPort, "127.0.0.1"), idleTimeoutMs: 300 });
    const { line, socket } = await connectRaw(fleet.ports.developer, `${GRANTED}:443`);
    assert.equal(line, "HTTP/1.1 200 Connection Established");
    const closed = new Promise((resolve) => socket.on("close", () => resolve(Date.now())));
    const keepAlive = setInterval(() => socket.write("x"), 100);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(socket.destroyed, false, "traffic keeps the tunnel open");
    clearInterval(keepAlive);
    const t = Date.now();
    const at = await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("tunnel never closed")), 3000).unref())]);
    assert.ok(at - t < 2000);
  });
});
