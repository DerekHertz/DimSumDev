// den-mvp/88 (ADR 0027 decision 1 and 2): `den:install` installs the router as its own user unit, outside any release, and
// writes the service token. The host is faked as in den-service.test.mjs. Pinned:
//   - unit name `den-router.service` (exported as ROUTER_UNIT_NAME from den-service.mjs), written to the unit dir beside den.service,
//     from the template apps/router/den-router.service (the same @NODE@ @CHECKOUT@ @STATE@ @PATH@ marks, filled by renderUnit)
//   - its ExecStart names a .mjs file that exists after install and is not inside any release or link folder of the state dir
//   - install writes <state>/service-token (mode 0600, kept when install runs again) and the token appears in no unit file and
//     in no line install says
//   - systemctl: `enable den-router.service` and `restart den-router.service`; den:update never touches the router unit
//     (a router change takes effect when the user runs den:install again)
// Existing den-service.test.mjs assertions on the exact systemctl calls and on readdirSync(unitDir) change with this ticket.
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as service from "./den-service.mjs";
const { createDen, UNIT_NAME } = service;
const ROUTER_UNIT_NAME = "den-router.service"; // service.ROUTER_UNIT_NAME must equal it (first test)
import { createReleases } from "../build/releases.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const LOCK = '{"name":"x","lockfileVersion":3,"packages":{}}\n';
const fakeBox = { async build({ folder }) {
  await mkdir(path.join(folder, "apps/ui/dist"), { recursive: true });
  await writeFile(path.join(folder, "apps/ui/dist/index.html"), "ui");
  return { ok: true, files: 1, bytes: 2, tail: "" };
} };

describe("den:install and the router", () => {
  let tmp, origin, checkout, state, unitDir, lines, sysCalls;
  const push = (n) => {
    execFileSync("sh", ["-c", `printf %s "$1" > "$2"`, "sh", `c${n}\n`, path.join(origin, "src.txt")]);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", `c${n}`);
  };
  const den = () => createDen({
    env: { HOME: tmp, PATH: "/usr/bin:/bin" }, say: (l) => lines.push(l), node: "/usr/bin/node", repo: checkout, stateDir: state, unitDir,
    bus: { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" } }, bwrap: "/usr/bin/bwrap",
    systemctl: async (args) => (sysCalls.push(args.join(" ")), { ok: true, out: "", err: "" }),
    answers: async () => true,
    releases: createReleases({ stateDir: state, repo: checkout, main: "origin/main", box: fakeBox, npm: async (cwd) => mkdir(path.join(cwd, "node_modules")) }),
  });

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-router-install-"));
    origin = path.join(tmp, "origin");
    await mkdir(origin);
    git(tmp, "init", "-q", "-b", "main", origin);
    await writeFile(path.join(origin, "package-lock.json"), LOCK);
    await writeFile(path.join(origin, "package.json"), '{"name":"x"}\n');
    push(1);
    git(tmp, "clone", "-q", origin, path.join(tmp, "checkout"));
    checkout = path.join(tmp, "checkout");
  });
  beforeEach(() => {
    state = path.join(tmp, `state-${Math.random().toString(36).slice(2)}`);
    unitDir = path.join(tmp, `units-${Math.random().toString(36).slice(2)}`);
    lines = [];
    sysCalls = [];
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  test("install writes den-router.service beside den.service and enables and starts it", async () => {
    assert.equal(service.ROUTER_UNIT_NAME, ROUTER_UNIT_NAME);
    await den().install();
    assert.deepEqual(readdirSync(unitDir).sort(), [ROUTER_UNIT_NAME, UNIT_NAME].sort());
    for (const call of ["enable den-router.service", "restart den-router.service"]) assert.ok(sysCalls.includes(call), `${call} in ${sysCalls.join(" | ")}`);
    const unit = await readFile(path.join(unitDir, ROUTER_UNIT_NAME), "utf8");
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(unit.replace(/^#.*$/gm, ""), /@[A-Z]+@/);
  });

  test("the router runs from a file outside every release and link folder, and that file exists", async () => {
    await den().install();
    const unit = await readFile(path.join(unitDir, ROUTER_UNIT_NAME), "utf8");
    const exec = unit.match(/^ExecStart=\S+ (\S+\.mjs)\s*$/m);
    assert.ok(exec, "ExecStart names /usr/bin/node and one .mjs file");
    assert.equal(existsSync(exec[1]), true, exec[1]);
    for (const inside of ["releases", "deps", "bridge", "ui", "previews"]) assert.equal(path.relative(path.join(state, inside), exec[1]).startsWith(".."), true, inside);
  });

  test("install writes the service token (0600) in the state folder, keeps it when run again, and leaks it nowhere", async () => {
    await den().install();
    const file = path.join(state, "service-token");
    const token = (await readFile(file, "utf8")).trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    await den().install();
    assert.equal((await readFile(file, "utf8")).trim(), token);
    for (const name of readdirSync(unitDir)) assert.equal((await readFile(path.join(unitDir, name), "utf8")).includes(token), false, name);
    assert.equal(lines.some((l) => l.includes(token)), false);
  });

  test("the plan install prints names the router", async () => {
    await den().install();
    assert.ok(lines.some((l) => /router/i.test(l)));
  });

  test("update leaves the router unit, its file and its token alone and does not restart it", async () => {
    await den().install();
    const unit = await readFile(path.join(unitDir, ROUTER_UNIT_NAME), "utf8");
    const token = await readFile(path.join(state, "service-token"), "utf8");
    push(2);
    git(checkout, "pull", "-q", "--ff-only");
    sysCalls.length = 0;
    await den().update("--main");
    assert.equal(await readFile(path.join(unitDir, ROUTER_UNIT_NAME), "utf8"), unit);
    assert.equal(await readFile(path.join(state, "service-token"), "utf8"), token);
    assert.equal(sysCalls.some((c) => c.includes("den-router")), false, sysCalls.join(" | "));
  });
});
