// den-mvp outcome 5 (ADR 0026 decision 4): the install and update steps against a temporary repository and state folder, with
// the systemd calls, the build box and `npm ci` faked, and the unit text tested as text. The real run is the user's.
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDen, DenServiceError, renderUnit, ROUTER_UNIT_NAME, SLICE_NAME, UNIT_NAME } from "./den-service.mjs";
import * as releasesModule from "../build/releases.mjs";
const { createReleases } = releasesModule;
const readUpdateFailure = (...a) => releasesModule.readUpdateFailure(...a);
const recordUpdateFailure = (...a) => releasesModule.recordUpdateFailure(...a);

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const TEMPLATE = readFileSync(new URL("./den.service", import.meta.url), "utf8");
const LOCK = '{"name":"x","lockfileVersion":3,"packages":{}}\n';

const fakeBox = (calls) => ({
  async build({ folder }) {
    calls.push(folder);
    await mkdir(path.join(folder, "apps/ui/dist"), { recursive: true });
    await writeFile(path.join(folder, "apps/ui/dist/index.html"), "ui");
    return { ok: true, files: 1, bytes: 2, tail: "" };
  },
});

describe("the unit text", () => {
  const values = { node: "/usr/bin/node", checkout: "/home/me/dimsumdev", state: "/home/me/.local/state/den", searchPath: "/home/me/.local/bin:/usr/bin" };

  test("runs the launcher (outside every release), in den.slice, on 4317, restarting on failure, in the checkout", () => {
    const text = renderUnit(TEMPLATE, values);
    assert.match(text, /^Slice=den\.slice$/m);
    assert.match(text, /^WorkingDirectory=\/home\/me\/dimsumdev$/m);
    assert.match(text, /^ExecStart=\/usr\/bin\/node \/home\/me\/\.local\/state\/den\/launcher\/den-launcher\.mjs$/m);
    assert.doesNotMatch(text.replace(/^#.*$/gm, ""), /bridge\/current|server\.mjs/, "the unit no longer names a release");
    assert.match(text, /^Environment=PORT=4317$/m);
    assert.match(text, /^Environment="PATH=\/home\/me\/\.local\/bin:\/usr\/bin"$/m);
    assert.match(text, /^Restart=on-failure$/m);
    assert.match(text, /^SuccessExitStatus=143$/m); // the bridge's own exit on SIGTERM: a stop is not a failure
    assert.match(text, new RegExp(`^Environment=DEN_STATE_DIR=${values.state}$`, "m")); // the folder the releases were made in
    assert.match(text, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(text.replace(/^#.*$/gm, ""), /@[A-Z]+@/);
  });

  // Probed 2026-10-18 under systemd 255: with these the bridge still starts an agent scope with bwrap inside it.
  test("the bridge gains no privileges and passes none on to the agents it starts", () => {
    const text = renderUnit(TEMPLATE, values);
    for (const line of ["NoNewPrivileges=yes", "RestrictSUIDSGID=yes", "LockPersonality=yes"]) assert.match(text, new RegExp(`^${line}$`, "m"), line);
  });

  test("den.slice bounds the whole den (bridge, agents, checks, guard) below the machine's memory", () => {
    const slice = readFileSync(new URL("./den.slice", import.meta.url), "utf8");
    assert.match(slice, /^\[Slice\]$/m);
    assert.match(slice, /^MemoryMax=75%$/m);
    assert.match(slice, /^MemorySwapMax=0$/m);
    assert.match(slice, /^TasksMax=4096$/m);
    assert.equal(SLICE_NAME, "den.slice");
  });

  test("a value a unit file could not hold safely is refused, not quoted", () => {
    for (const bad of ["/home/my user/node", "/home/me/%h/node", "/home/me/node\nExecStartPre=/bin/evil", "relative/node", '/home/"x"/node', "/home/$HOME/node"]) {
      assert.throws(() => renderUnit(TEMPLATE, { ...values, node: bad }), DenServiceError, bad);
      assert.throws(() => renderUnit(TEMPLATE, { ...values, checkout: bad }), DenServiceError, bad);
      assert.throws(() => renderUnit(TEMPLATE, { ...values, state: bad }), DenServiceError, bad);
    }
  });

  test("PATH keeps only plain absolute entries", () => {
    const text = renderUnit(TEMPLATE, { ...values, searchPath: '/usr/bin:relative:/mnt/c/Program Files/x:/bad"quote:/bad%h:/ok/bin' });
    assert.match(text, /^Environment="PATH=\/usr\/bin:\/mnt\/c\/Program Files\/x:\/ok\/bin"$/m);
    assert.throws(() => renderUnit(TEMPLATE, { ...values, searchPath: "relative:%h" }), /no usable entries/);
  });
});

describe("den:install and den:update", () => {
  let tmp, origin, checkout, state, unitDir, lines, calls, sysCalls, npmCalls, boxCalls, answered;
  const push = (n) => {
    execFileSync("sh", ["-c", `printf %s "$1" > "$2"`, "sh", `c${n}\n`, path.join(origin, "src.txt")]);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", `c${n}`);
    return git(origin, "rev-parse", "HEAD");
  };
  const den = (over = {}) => createDen({
    env: { HOME: tmp, PATH: "/usr/bin:/bin" }, say: (line) => lines.push(line), node: "/usr/bin/node", repo: checkout, stateDir: state, unitDir,
    bus: { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" } }, bwrap: "/usr/bin/bwrap",
    systemctl: async (args) => (sysCalls.push(args.join(" ")), { ok: true, out: "", err: "" }),
    answers: async () => answered,
    releases: createReleases({ stateDir: state, repo: checkout, main: "origin/main", box: fakeBox(boxCalls), npm: async (cwd) => { npmCalls.push(cwd); await mkdir(path.join(cwd, "node_modules")); } }),
    ...over,
  });

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-service-"));
    origin = path.join(tmp, "origin");
    await mkdir(origin);
    git(tmp, "init", "-q", "-b", "main", origin);
    await writeFile(path.join(origin, "package-lock.json"), LOCK);
    await writeFile(path.join(origin, "package.json"), '{"name":"x"}\n');
    push(1);
    git(tmp, "clone", "-q", origin, path.join(tmp, "checkout"));
    checkout = path.join(tmp, "checkout");
  });
  beforeEach(async () => {
    state = path.join(tmp, `state-${Math.random().toString(36).slice(2)}`);
    unitDir = path.join(tmp, `units-${Math.random().toString(36).slice(2)}`);
    lines = [];
    sysCalls = [];
    npmCalls = [];
    boxCalls = [];
    answered = true;
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  const link = (pair, name) => readlinkSync(path.join(state, pair, name));

  test("install makes the packages, the first release, the four links, the unit, and starts the service", async () => {
    await den().install();
    const sha = git(origin, "rev-parse", "HEAD");
    assert.equal(npmCalls.length, 1);
    assert.equal(boxCalls.length, 1);
    assert.equal(link("ui", "current"), `../releases/${sha.slice(0, 12)}`);
    assert.equal(link("bridge", "current"), `../releases/${sha.slice(0, 12)}`);
    const unit = await readFile(path.join(unitDir, UNIT_NAME), "utf8");
    assert.match(unit, new RegExp(`ExecStart=/usr/bin/node ${state}/launcher/den-launcher.mjs\n`));
    assert.match(unit, new RegExp(`WorkingDirectory=${checkout}`));
    assert.deepEqual(sysCalls, ["show-environment", "daemon-reload", "enable den.service", "restart den.service", "enable den-router.service", "restart den-router.service"]);
    assert.deepEqual(readdirSync(unitDir).sort(), [ROUTER_UNIT_NAME, SLICE_NAME, UNIT_NAME].sort());
    assert.equal(readFileSync(path.join(unitDir, SLICE_NAME), "utf8"), readFileSync(new URL("./den.slice", import.meta.url), "utf8"));
  });

  const LAUNCHER_SOURCE = path.join(path.dirname(new URL(import.meta.url).pathname), "den-launcher.mjs");

  test("install writes the launcher beside the releases, not inside any release or link folder (den-mvp/77)", async () => {
    await den().install();
    const installed = path.join(state, "launcher", "den-launcher.mjs");
    assert.equal(readFileSync(installed, "utf8"), readFileSync(LAUNCHER_SOURCE, "utf8"));
    for (const inside of ["releases", "deps", "bridge", "ui", "previews"]) assert.equal(path.relative(path.join(state, inside), installed).startsWith(".."), true, inside);
  });

  test("a release cannot overwrite the launcher: update leaves it as install wrote it, even when a release carries its own copy (den-mvp/77)", async () => {
    await den().install();
    const installed = path.join(state, "launcher", "den-launcher.mjs");
    const before = readFileSync(installed, "utf8");
    await mkdir(path.join(origin, "apps", "bridge", "service"), { recursive: true });
    await writeFile(path.join(origin, "apps", "bridge", "service", "den-launcher.mjs"), "// a release's copy\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "a release that carries a launcher");
    git(checkout, "pull", "-q", "--ff-only");
    await den().update("--main");
    assert.equal(readFileSync(installed, "utf8"), before);
    const newest = link("bridge", "current").split("/").pop();
    assert.equal(readFileSync(path.join(state, "releases", newest, "apps/bridge/service/den-launcher.mjs"), "utf8"), "// a release's copy\n");
    git(origin, "reset", "-q", "--hard", "HEAD~1");
    git(checkout, "fetch", "-q");
    git(checkout, "reset", "-q", "--hard", "origin/main");
  });

  test("it prints the plan first, then each step's result", async () => {
    await den().install();
    assert.equal(lines[0], "This will:");
    const planned = lines.slice(1, lines.indexOf("> fetch origin main")).map((l) => l.replace(/^\s+\d+\. /, ""));
    assert.equal(planned.length, 9);
    const started = lines.filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
    assert.deepEqual(started, planned);
    assert.equal(lines.filter((l) => l.startsWith("  done")).length, 9);
    assert.match(lines.find((l) => l.startsWith("  done: ") && /answers on 4317/.test(l)), /4317/);
  });

  test("running install again is safe: nothing is rebuilt, the unit is rewritten, the service restarted", async () => {
    await den().install();
    sysCalls.length = 0;
    await den().install();
    assert.equal(npmCalls.length, 1);
    assert.equal(boxCalls.length, 1);
    assert.deepEqual(sysCalls, ["show-environment", "daemon-reload", "enable den.service", "restart den.service", "enable den-router.service", "restart den-router.service"]);
    assert.deepEqual(readdirSync(unitDir).sort(), [ROUTER_UNIT_NAME, SLICE_NAME, UNIT_NAME].sort());
  });

  describe("on a host that cannot run it, install refuses and leaves nothing behind", () => {
    const refuses = async (over, message) => {
      await assert.rejects(den(over).install(), (err) => err instanceof DenServiceError && message.test(err.message));
      assert.equal(existsSync(state), false);
      assert.equal(existsSync(unitDir), false);
      assert.deepEqual(sysCalls.filter((c) => c !== "show-environment"), []);
      assert.equal(lines.some((l) => l.startsWith("> ")), false);
    };
    test("no systemd user manager (no bus)", () => refuses({ bus: { reason: "the user service manager's bus is not reachable at /run/user/1000/bus" } }, /no reachable systemd user manager: .*not reachable/));
    test("systemctl will not answer", () => refuses({ systemctl: async (args) => (sysCalls.push(args.join(" ")), { ok: false, out: "", err: "System has not been booted with systemd" }) }, /no usable systemd user manager.*not been booted with systemd/));
    test("no systemctl at all", () => refuses({ systemctl: async () => ({ ok: false, out: "", err: "spawn systemctl ENOENT" }) }, /no usable systemd user manager/));
    test("no bubblewrap", () => refuses({ bwrap: null }, /bubblewrap/));
    test("not Linux", () => refuses({ platform: "darwin" }, /Linux or WSL/));
    test("a path a unit file cannot hold", () => refuses({ node: "/opt/my node/bin/node" }, /plainer path/));
    test("not a git checkout", () => refuses({ repo: tmp }, /not a git checkout/));
  });

  test("a failing step stops the run and names it; the unit is not written", async () => {
    const failing = createReleases({ stateDir: state, repo: checkout, main: "origin/main", box: { build: async () => ({ ok: false, reason: "the resource group refused the build" }) }, npm: async (cwd) => mkdir(path.join(cwd, "node_modules")) });
    await assert.rejects(den({ releases: failing }).install(), /resource group refused/);
    assert.ok(lines.some((l) => l.startsWith("  FAILED: ") && /resource group/.test(l)));
    assert.equal(existsSync(unitDir), false);
    assert.equal(existsSync(path.join(state, "ui", "current")), false);
  });

  test("install says so when the service does not answer", async () => {
    answered = false;
    await assert.rejects(den().install(), /did not answer on port 4317/);
  });

  test("update before install is refused", async () => {
    await assert.rejects(den().update("--main"), /npm run den:install first/);
    assert.equal(existsSync(state), false);
  });

  test("update makes a release of the new main, switches both links and restarts; packages are not reinstalled when the lockfile is the same", async () => {
    await den().install();
    const first = git(origin, "rev-parse", "HEAD");
    const second = push(2);
    sysCalls.length = 0;
    await den().update("--main");
    assert.equal(npmCalls.length, 1);
    assert.equal(boxCalls.length, 2);
    assert.deepEqual([link("ui", "current"), link("ui", "previous")], [`../releases/${second.slice(0, 12)}`, `../releases/${first.slice(0, 12)}`]);
    assert.deepEqual([link("bridge", "current"), link("bridge", "previous")], [`../releases/${second.slice(0, 12)}`, `../releases/${first.slice(0, 12)}`]);
    assert.deepEqual(sysCalls, ["show-environment", "restart den.service"]);
  });

  const boxChange = async () => {
    await mkdir(path.join(origin, "apps", "bridge", "build"), { recursive: true });
    await writeFile(path.join(origin, "apps", "bridge", "build", "box.mjs"), `// new wrapper ${Date.now()} ${Math.random()}\n`);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "box change");
  };

  test("a checkout on main that is only behind is fast-forwarded, nothing is built, and the update asks to be run again (friction F15)", async () => {
    await den().install();
    await boxChange();
    await writeFile(path.join(checkout, "local-note.txt"), "uncommitted\n");
    const boxesBefore = boxCalls.length;
    sysCalls.length = 0;
    await assert.rejects(den().update("--main"), (err) => err.rerun === true && /fast-forwarded/.test(err.message));
    assert.equal(git(checkout, "rev-parse", "HEAD"), git(origin, "rev-parse", "HEAD"), "the checkout is at main");
    assert.equal(existsSync(path.join(checkout, "local-note.txt")), true, "an uncommitted file stays");
    assert.equal(boxCalls.length, boxesBefore, "no release was built with the old code");
    assert.deepEqual(sysCalls, ["show-environment"], "nothing was restarted");
    await den().update("--main");
    assert.equal(link("bridge", "current"), `../releases/${git(origin, "rev-parse", "HEAD").slice(0, 12)}`);
  });

  test("update refuses when the checkout's own build code differs and the checkout is not on main, and changes nothing (friction F15)", async () => {
    await den().install();
    await boxChange();
    git(checkout, "switch", "-q", "-c", "side");
    const boxesBefore = boxCalls.length;
    sysCalls.length = 0;
    await assert.rejects(den().update("--main"), (err) => !err.rerun && /apps\/bridge\/build\/box\.mjs.*git pull --ff-only/.test(err.message));
    git(checkout, "switch", "-q", "main");
    assert.equal(boxCalls.length, boxesBefore, "no release was built");
    assert.deepEqual(sysCalls, ["show-environment"], "nothing was restarted");
    git(checkout, "pull", "-q", "--ff-only");
    await den().update("--main");
    assert.equal(link("bridge", "current"), `../releases/${git(origin, "rev-parse", "HEAD").slice(0, 12)}`);
  });

  test("update with nothing new does not restart the service", async () => {
    await den().install();
    sysCalls.length = 0;
    lines.length = 0;
    await den().update("--main");
    assert.deepEqual(sysCalls, ["show-environment"]);
    assert.ok(lines.some((l) => /skipped, nothing changed/.test(l)));
    assert.equal(boxCalls.length, 1);
  });

  describe("which release update installs (den-mvp/44)", () => {
    const tag = (name, sha) => git(origin, "tag", name, ...(sha ? [sha] : []));
    const untag = () => [origin, checkout].forEach((repo) => git(repo, "tag", "--list").split("\n").filter(Boolean).forEach((t) => git(repo, "tag", "-d", t)));
    const recorded = (pair) => JSON.parse(readFileSync(path.join(state, "releases", link(pair, "current").split("/").pop(), "build.json"), "utf8"));
    after(untag);

    test("with no argument it installs the newest v* tag, not the tip of main, and records the tag", async () => {
      untag();
      const one = git(origin, "rev-parse", "HEAD");
      tag("v0.1.0", one);
      await den().install(); // running: v0.1.0's commit
      const two = push(20);
      tag("v0.2.0", two);
      tag("v0.10.0", two); // semver order: 0.10.0 is newer than 0.2.0
      tag("not-a-release", two);
      const tip = push(21);
      await den().update();
      assert.equal(link("bridge", "current"), `../releases/${two.slice(0, 12)}`);
      assert.notEqual(two, tip);
      assert.equal(recorded("bridge").tag, "v0.10.0");
    });

    test("--main installs the tip of main, untagged", async () => {
      const tip = git(origin, "rev-parse", "HEAD");
      await den().install();
      await den().update("--main");
      assert.equal(link("bridge", "current"), `../releases/${tip.slice(0, 12)}`);
      assert.equal(recorded("bridge").tag, undefined);
    });

    test("a tag name installs that tag (a rollback)", async () => {
      const one = git(origin, "rev-parse", "v0.1.0");
      await den().install();
      await den().update("v0.1.0");
      assert.equal(link("bridge", "current"), `../releases/${one.slice(0, 12)}`);
      assert.equal(recorded("ui").tag, "v0.1.0");
    });

    test("an unknown tag is refused with the known ones, and nothing changes", async () => {
      await den().install();
      sysCalls.length = 0;
      await assert.rejects(den().update("v9.9.9"), (err) => err instanceof DenServiceError && /v9\.9\.9/.test(err.message) && /v0\.1\.0/.test(err.message) && /v0\.10\.0/.test(err.message));
      assert.deepEqual(sysCalls, ["show-environment"]);
    });

    test("with no tags at all, no argument is refused and says to use --main", async () => {
      untag();
      await den().install();
      await assert.rejects(den().update(), /no release tags.*--main/);
    });
  });

  describe("update never goes backwards on its own, and does not retry a failed tag (den-mvp/77)", () => {
    const tag = (name, sha) => git(origin, "tag", name, sha);
    const untag = () => [origin, checkout].forEach((repo) => git(repo, "tag", "--list").split("\n").filter(Boolean).forEach((t) => git(repo, "tag", "-d", t)));
    beforeEach(untag);
    after(untag);

    test("a bare update whose newest tag is older than the running release is refused; naming the tag is the user's say", async () => {
      const one = git(origin, "rev-parse", "HEAD");
      tag("v0.1.0", one);
      const two = push(60); // main moves on, untagged
      await den().install(); // running: two (untagged), as on 2026-10-17
      sysCalls.length = 0;
      await assert.rejects(den().update(), (err) => err instanceof DenServiceError && /older/i.test(err.message) && /v0\.1\.0/.test(err.message));
      assert.equal(link("bridge", "current"), `../releases/${two.slice(0, 12)}`, "nothing was switched");
      assert.equal(link("ui", "current"), `../releases/${two.slice(0, 12)}`);
      assert.deepEqual(sysCalls, ["show-environment"], "nothing was restarted");
      await den().update("v0.1.0"); // named: a rollback the user asked for
      assert.equal(link("bridge", "current"), `../releases/${one.slice(0, 12)}`);
      assert.deepEqual(sysCalls, ["show-environment", "show-environment", "restart den.service"]);
    });

    test("a tag that failed to start is not taken by a bare update; naming it clears the record", async () => {
      await den().install();
      const next = push(61);
      tag("v0.5.0", next);
      await recordUpdateFailure(state, { sha: next, tag: "v0.5.0", reason: "the den did not answer within 30 seconds" });
      sysCalls.length = 0;
      await assert.rejects(den().update(), (err) => err instanceof DenServiceError && /v0\.5\.0/.test(err.message) && /fail/i.test(err.message));
      assert.deepEqual(sysCalls, ["show-environment"]);
      assert.equal((await readUpdateFailure(state)).tag, "v0.5.0", "the record is kept");
      await den().update("v0.5.0");
      assert.equal(link("bridge", "current"), `../releases/${next.slice(0, 12)}`);
      assert.equal(await readUpdateFailure(state), null, "the user asked, so the record is cleared");
    });
  });

  test("nothing under apps/bridge except this folder names the den's unit, so the bridge cannot restart it (den-mvp/77)", () => {
    const bridge = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const walk = (dir) => readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      if (file === path.join(bridge, "service")) return [];
      return statSync(file).isDirectory() ? walk(file) : file.endsWith(".mjs") && !file.endsWith(".test.mjs") ? [file] : [];
    });
    for (const file of walk(bridge)) assert.doesNotMatch(readFileSync(file, "utf8"), /den\.service|UNIT_NAME/, file);
  });

  test("nothing under apps/bridge except this folder imports the install or update scripts", () => {
    const bridge = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const walk = (dir) => readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      if (file === path.join(bridge, "service")) return [];
      return statSync(file).isDirectory() ? walk(file) : file.endsWith(".mjs") && !file.endsWith(".test.mjs") ? [file] : [];
    });
    for (const file of walk(bridge)) assert.doesNotMatch(readFileSync(file, "utf8"), /den-service/, file);
  });
});

// F39: npm run den:link signals the running den for one more launch URL and reads it back from the den's journal.
describe("den:link", () => {
  const URL_A = `http://127.0.0.1:4317/#code=${"a".repeat(43)}`, URL_B = `http://127.0.0.1:4317/#code=${"b".repeat(43)}`;
  const den = ({ journal, systemctl, lines }) => createDen({
    env: { HOME: "/nonexistent", PATH: "/usr/bin:/bin" }, say: (line) => lines.push(line), repo: "/nonexistent/repo", stateDir: "/nonexistent/state", unitDir: "/nonexistent/units",
    bus: { env: {} }, bwrap: null, systemctl, journal, linkWaitMs: 1,
  });
  test("signals the den's main process with SIGUSR2 and prints the newest link it logged", async () => {
    const sys = [], jr = [], lines = [];
    let calls = 0;
    const url = await den({
      lines,
      systemctl: async (args) => (sys.push(args.join(" ")), { ok: true, out: "", err: "" }),
      journal: async (args) => (jr.push(args), { ok: true, out: (calls += 1) < 3 ? "" : `bridge listening\nto steer, open (one use, 5 minutes): ${URL_A}\nto steer, open (one use, 5 minutes): ${URL_B}\n`, err: "" }),
    }).link();
    assert.deepEqual(sys, ["kill --signal=SIGUSR2 --kill-whom=main den.service"]);
    assert.ok(jr.every((a) => a.includes("den.service") && a.includes("--since")), "only the den's own lines, only since the signal");
    assert.equal(url, URL_B);
    assert.ok(lines.some((l) => l.includes(URL_B)));
  });
  test("a den that is not running, or that prints no link, is a clear error", async () => {
    const lines = [];
    await assert.rejects(den({ lines, systemctl: async () => ({ ok: false, out: "", err: "Unit den.service not loaded." }), journal: async () => ({ ok: true, out: "", err: "" }) }).link(), /is the den running\?.*not loaded/);
    await assert.rejects(den({ lines, systemctl: async () => ({ ok: true, out: "", err: "" }), journal: async () => ({ ok: true, out: "nothing here\n", err: "" }) }).link(), /printed no link/);
  });
});
