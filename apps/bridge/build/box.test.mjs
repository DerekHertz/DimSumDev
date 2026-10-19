// den-mvp/06 (ADR 0026 decision 2): the build box.
//   pure      the bubblewrap argv, the output bounds
//   refusal   with bubblewrap or the resource group missing nothing is started, and the refusal names the blocker
//   live      probe builds in real bubblewrap, through the launcher production uses. These need bubblewrap, a reachable
//             user service manager and an installed Vite; where one is missing they are skipped with that reason.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EnforcementError, createResourceLauncher, findUserBus } from "../agents/resource-group.mjs";
import { unconfinedLauncher } from "../agents/launcher-test-helpers.mjs";
import { UI_CONFIG, VITE_BIN, buildBoxArgv, createBuildBox, findBwrap, libraryArgs, measureOutput } from "./box.mjs";
import { findPackages, makeProbeFolder } from "./box-test-helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, { ms = 15_000, what = "the condition" } = {}) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(25);
  }
};
const made = [];
const temp = async (prefix, parent = tmpdir()) => {
  const dir = await mkdtemp(path.join(parent, prefix));
  made.push(dir);
  return dir;
};
const probeFolder = async (input) => {
  const folder = await makeProbeFolder(input);
  made.push(folder);
  return folder;
};
// Registered in every suite: a hook at the top of this file does not wait for the live suite.
const cleanup = () => Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));

describe("the bubblewrap argv", () => {
  const argv = buildBoxArgv({ folder: "/srv/release", packages: "/srv/deps/abc/node_modules", node: "/opt/node/bin/node", libs: ["--ro-bind", "/usr/lib", "/usr/lib"] });
  const pairs = (flag, width) => argv.flatMap((a, i) => (a === flag ? [argv.slice(i + 1, i + 1 + width)] : []));

  test("one fixed command: vite build with the UI's config, nothing from the caller", () => {
    assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["/den/node", `/node_modules/${VITE_BIN}`, "build", "--config", `/build/${UI_CONFIG}`, "--configLoader", "native"]);
  });

  test("no network, own namespaces, ends with its parent, a cleared environment", () => {
    for (const flag of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]) assert.ok(argv.includes(flag), flag);
    assert.ok(!argv.includes("--share-net"));
    assert.deepEqual(pairs("--setenv", 2), [["HOME", "/tmp"], ["TMPDIR", "/tmp"]]);
  });

  test("one writable bind (the folder's apps/ui/dist); everything else is read-only, the folder and the root included", () => {
    assert.deepEqual(pairs("--bind", 2), [["/srv/release/apps/ui/dist", "/build/apps/ui/dist"]]);
    assert.deepEqual(pairs("--ro-bind", 2), [["/usr/lib", "/usr/lib"], ["/opt/node/bin/node", "/den/node"], ["/srv/deps/abc/node_modules", "/node_modules"], ["/srv/release", "/build"]]);
    assert.ok(argv.indexOf("/build") < argv.indexOf("/build/apps/ui/dist"), "the writable folder is mounted over the read-only one");
    assert.deepEqual(pairs("--tmpfs", 1), [["/tmp"]]);
    assert.deepEqual(pairs("--remount-ro", 1), [["/"]]);
    assert.ok(!argv.includes("--dev-bind") && !argv.includes("--bind-try") && !argv.includes("--ro-bind-try"));
  });

  test("a path that is not absolute is a caller error", () => {
    assert.throws(() => buildBoxArgv({ folder: "release", packages: "/p", node: "/n", libs: [] }), TypeError);
    assert.throws(() => buildBoxArgv({ folder: "/f", packages: "/p", node: "node", libs: [] }), TypeError);
  });

  test("library folders: a real folder is bound read-only, a link is remade, a missing one is left out", () => {
    const stat = (dir) => ({ "/usr/lib": { isSymbolicLink: () => false, isDirectory: () => true }, "/lib": { isSymbolicLink: () => true, isDirectory: () => false } })[dir] ?? null;
    assert.deepEqual(libraryArgs(["/usr/lib", "/usr/lib64", "/lib"], { stat, readlink: () => "usr/lib" }), ["--ro-bind", "/usr/lib", "/usr/lib", "--symlink", "usr/lib", "/lib"]);
  });
});

describe("the output bounds", () => {
  after(cleanup);
  const outDir = async () => {
    const dir = await temp("den-box-out-");
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "index.html"), "12345");
    await writeFile(path.join(dir, "assets/app.js"), "1234567");
    return dir;
  };

  test("plain files and folders are counted", async () => {
    assert.deepEqual(await measureOutput(await outDir()), { files: 2, bytes: 12 });
  });

  test("a symbolic link is a refusal, also one that points inside the output", async () => {
    const dir = await outDir();
    await symlink("index.html", path.join(dir, "assets/again.html"));
    await assert.rejects(measureOutput(dir), /contains a link: assets\/again\.html/);
  });

  test("a hard link is a refusal", async () => {
    const dir = await outDir();
    await link(path.join(dir, "index.html"), path.join(dir, "twin.html"));
    await assert.rejects(measureOutput(dir), /contains a hard link/);
  });

  test("more files than the bound, or more bytes, is a refusal", async () => {
    const dir = await outDir();
    await assert.rejects(measureOutput(dir, { maxFiles: 1 }), /more than 1 files/);
    await assert.rejects(measureOutput(dir, { maxBytes: 11 }), /larger than 11 bytes/);
    assert.deepEqual(await measureOutput(dir, { maxFiles: 2, maxBytes: 12 }), { files: 2, bytes: 12 });
  });
});

describe("refusal: nothing builds outside the box", () => {
  after(cleanup);
  let folder;
  let packages;
  before(async () => {
    folder = await probeFolder({});
    packages = await temp("den-box-deps-");
    await mkdir(path.join(packages, "vite/bin"), { recursive: true });
    await writeFile(path.join(packages, VITE_BIN), "");
  });
  const counting = (launch) => {
    const launcher = { enforced: true, calls: 0, launch: async (run) => ((launcher.calls += 1), launch(run)) };
    return launcher;
  };
  const untouched = () => assert.ok(!existsSync(path.join(folder, "apps/ui/dist")) && !existsSync(path.join(folder, "apps/ui/dist/probe.json")), "the probe never ran");

  test("no bubblewrap: refused, the blocker is named, the launcher is never asked", async () => {
    const launcher = counting(async () => assert.fail("launched"));
    const result = await createBuildBox({ launcher, bwrap: findBwrap(["/nonexistent/bwrap"]) }).build({ folder, packages });
    assert.deepEqual(result, { ok: false, files: 0, bytes: 0, tail: "", reason: "bubblewrap (bwrap) is not installed; the build box cannot be made without it", code: "environment" });
    assert.equal(launcher.calls, 0);
    untouched();
  });

  test("no launcher, or one that does not enforce the resource group: refused before anything starts", async () => {
    for (const launcher of [undefined, unconfinedLauncher()]) {
      const result = await createBuildBox({ launcher }).build({ folder, packages });
      assert.equal(result.ok, false);
      assert.match(result.reason, /no resource group/);
    }
    untouched();
  });

  test("the launcher refuses (no user service manager): refused with the launcher's own reason", async () => {
    const launcher = counting(async () => {
      throw new EnforcementError("the user service manager's bus is not reachable at /run/user/1000/bus");
    });
    const result = await createBuildBox({ launcher, bwrap: process.execPath }).build({ folder, packages });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^the resource group refused the build: the user service manager's bus is not reachable/);
    assert.equal(launcher.calls, 1);
    untouched();
  });

  test("a launcher that returns no group is not trusted: its child is killed and the build refused", async () => {
    const launcher = { ...unconfinedLauncher(), enforced: true };
    const result = await createBuildBox({ launcher, bwrap: "/bin/sleep", node: process.execPath }).build({ folder, packages });
    assert.match(result.reason, /no resource group/);
    untouched();
  });

  test("a folder without the UI's config, or packages without Vite: refused; a relative path is a caller error", async () => {
    const launcher = counting(async () => assert.fail("launched"));
    const box = createBuildBox({ launcher, bwrap: process.execPath });
    assert.match((await box.build({ folder: packages, packages })).reason, /has no apps\/ui\/vite\.config\.mjs/);
    assert.match((await box.build({ folder, packages: folder })).reason, /has no vite\/bin\/vite\.js/);
    await assert.rejects(box.build({ folder: "release", packages }), TypeError);
    assert.equal(launcher.calls, 0);
  });
});

// ---- live ----------------------------------------------------------------------------------
const launcher = createResourceLauncher();
const production = await launcher.preflight();
const packages = findPackages();
const skip = findBwrap() === null ? "bubblewrap (bwrap) is not installed on this host"
  : !production.ok ? `this host cannot enforce the limits: ${production.reason}`
  : packages === null ? "no installed Vite was found above this file (run npm ci)"
  : false;

describe("live: a probe build in the box", { skip }, () => {
  const box = createBuildBox({ launcher });
  const secret = ["den", "box", "secret"].join("-"); // built here: a quoted one trips the root secret scan
  let folder;
  let outside;
  let homeFile;
  let server;
  let result;
  let probe;
  let config;

  before(async () => {
    const home = await temp(".den-box-test-", homedir());
    homeFile = path.join(home, "secret.txt");
    await writeFile(homeFile, secret);
    outside = await temp("den-box-outside-");
    server = createServer((socket) => socket.destroy()).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    folder = await probeFolder({
      reads: [homeFile, "/etc/passwd", fileURLToPath(import.meta.url)],
      lists: [homedir(), "/home", "/etc"],
      writes: ["/build/apps/ui/dist/inside.txt", "/build/inside.txt", "/build/apps/bridge/server.mjs", "/build/apps/ui/vite.config.mjs", "/build/probe-input.json", "/tmp/scratch.txt", path.join(outside, "escaped.txt"), path.join(homedir(), "den-box-escaped.txt"), "/escaped.txt", "/node_modules/escaped.txt", "/usr/lib/escaped.txt"],
      port: server.address().port,
    });
    // What a release's folder also holds: the bridge code the service runs.
    await mkdir(path.join(folder, "apps/bridge"));
    await writeFile(path.join(folder, "apps/bridge/server.mjs"), "// the bridge\n");
    config = readFileSync(path.join(folder, UI_CONFIG), "utf8");
    result = await box.build({ folder, packages });
    const report = path.join(folder, "apps/ui/dist/probe.json");
    probe = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
  });
  after(() => (server?.close(), cleanup()));

  test("the probe builds: ok, with the output counted", () => {
    assert.equal(result.ok, true, `${result.reason}\n${result.tail}`);
    assert.ok(result.files >= 1 && result.bytes > 0);
    assert.ok(existsSync(path.join(folder, "apps/ui/dist/index.html")));
  });

  test("it cannot read a file in the home directory (or see the home directory at all)", () => {
    assert.deepEqual(probe.reads[homeFile], { ok: false, code: "ENOENT" });
    assert.equal(probe.reads["/etc/passwd"].ok, false);
    assert.equal(probe.reads[fileURLToPath(import.meta.url)].ok, false);
    for (const dir of Object.keys(probe.lists)) assert.equal(probe.lists[dir].ok, false, dir);
    assert.ok(!JSON.stringify(probe).includes(secret));
  });

  test("it can write to its output folder and nowhere else in its own folder: not the bridge's code, not its own config", () => {
    assert.equal(probe.writes["/build/apps/ui/dist/inside.txt"].ok, true);
    for (const file of ["/build/inside.txt", "/build/apps/bridge/server.mjs", "/build/apps/ui/vite.config.mjs", "/build/probe-input.json"]) {
      assert.deepEqual(probe.writes[file], { ok: false, code: "EROFS" }, file);
    }
    assert.ok(!existsSync(path.join(folder, "inside.txt")));
    assert.equal(readFileSync(path.join(folder, "apps/bridge/server.mjs"), "utf8"), "// the bridge\n");
    assert.equal(readFileSync(path.join(folder, UI_CONFIG), "utf8"), config);
  });

  test("it cannot write outside its folder", () => {
    assert.equal(probe.writes["/tmp/scratch.txt"].ok, true);
    assert.ok(!existsSync("/tmp/scratch.txt") || readFileSync("/tmp/scratch.txt", "utf8") !== "probe", "the box's /tmp is private");
    for (const file of [path.join(outside, "escaped.txt"), path.join(homedir(), "den-box-escaped.txt"), "/escaped.txt", "/node_modules/escaped.txt", "/usr/lib/escaped.txt"]) {
      assert.equal(probe.writes[file].ok, false, file);
      assert.ok(!existsSync(file), `${file} on the host`);
    }
    assert.ok(!existsSync(path.join(packages, "escaped.txt")));
  });

  test("it cannot open a network connection", () => {
    assert.equal(probe.net.ok, false);
  });

  test("a cleared environment, its own process namespace, and a root that holds only the box", () => {
    assert.deepEqual(probe.env.filter((name) => !["HOME", "TMPDIR", "PWD", "NODE_ENV"].includes(name)), []);
    assert.ok(probe.pid < 10, `pid ${probe.pid}`);
    assert.deepEqual(probe.root.filter((name) => !["build", "den", "dev", "lib", "lib64", "node_modules", "proc", "tmp", "usr"].includes(name)), []);
  });

  test("an output with a link, a hard link, or over the bounds is refused", async () => {
    const run = async (input, bounds = {}) => createBuildBox({ launcher, ...bounds }).build({ folder: await probeFolder(input), packages });
    const [linked, twinned, many, big] = await Promise.all([run({ symlink: true }), run({ hardlink: true }), run({ extraFiles: 5 }, { maxFiles: 4 }), run({ extraBytes: 4096 }, { maxBytes: 2048 })]);
    assert.deepEqual([linked.ok, linked.reason, linked.code], [false, "the build output contains a link: link.json", "build"]);
    assert.deepEqual([twinned.ok, twinned.files], [false, 0]);
    assert.match(twinned.reason, /hard link/);
    assert.equal(many.reason, "the build output has more than 4 files");
    assert.equal(big.reason, "the build output is larger than 2048 bytes");
  });

  test("a build that fails is not ok and its last output comes back", async () => {
    const broken = await probeFolder({});
    await writeFile(path.join(broken, UI_CONFIG), 'console.error("probe-broke");\nprocess.exit(3);\n');
    const failed = await box.build({ folder: broken, packages });
    assert.deepEqual([failed.ok, failed.reason, failed.files, failed.code], [false, "the build failed (exit 3)", 0, "build"]);
    assert.match(failed.tail, /probe-broke/);
  });

  test("the caller's stop ends a running build", async () => {
    const sleeping = await probeFolder({ sleep: true });
    const stopper = new AbortController();
    const running = box.build({ folder: sleeping, packages, signal: stopper.signal });
    await until(() => existsSync(path.join(sleeping, "apps/ui/dist/probe.json")), { what: "the build to start" });
    stopper.abort();
    assert.deepEqual(await running, { ok: false, files: 0, bytes: 0, tail: "", reason: "the build was stopped", code: "stopped" });
  });

  test("stopping the caller ends the build's processes", async () => {
    const sleeping = await probeFolder({ sleep: true });
    const caller = spawn(process.execPath, [fileURLToPath(new URL("./box-stop-probe.mjs", import.meta.url)), sleeping, packages], { stdio: "ignore" });
    const unit = `den-run-build-${caller.pid}-1.scope`;
    await until(() => existsSync(path.join(sleeping, "apps/ui/dist/probe.json")), { what: "the build to start" });
    const group = await new Promise((resolve) => execFile("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", unit], { env: findUserBus(process.env).env }, (_err, out) => resolve(String(out).trim())));
    assert.match(group, /den-run-build-/);
    const procs = () => {
      try {
        return readFileSync(path.join("/sys/fs/cgroup", group, "cgroup.procs"), "utf8").trim();
      } catch {
        return "";
      }
    };
    assert.notEqual(procs(), "", "the build is running in its own group");
    caller.kill("SIGKILL");
    await until(() => procs() === "", { what: "the build's processes to end" });
  });

  // ADR 0026 leaves this unchecked: point DEN_BOX_UI_PACKAGES at a node_modules made with `npm ci --ignore-scripts`.
  const uiPackages = process.env.DEN_BOX_UI_PACKAGES;
  test("the UI of this repository builds in the box", { skip: uiPackages ? false : "set DEN_BOX_UI_PACKAGES to a node_modules made with npm ci --ignore-scripts" }, async () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const copy = await temp("den-box-ui-");
    for (const dir of ["apps", "packages"]) await cp(path.join(repo, dir), path.join(copy, dir), { recursive: true, filter: (src) => !["node_modules", "dist"].includes(path.basename(src)) });
    const built = await box.build({ folder: copy, packages: uiPackages });
    assert.equal(built.ok, true, `${built.reason}\n${built.tail}`);
    assert.ok(existsSync(path.join(copy, "apps/ui/dist/index.html")));
    console.log(`UI build in the box: ${built.files} files, ${built.bytes} bytes`);
  });
});
