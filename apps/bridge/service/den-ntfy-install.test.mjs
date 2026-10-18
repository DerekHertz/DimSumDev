// den-mvp/88 (user decision 2026-10-17): `den:install` keeps the router's ntfy topic URL in <state>/ntfy-url (0600). It reads
// DEN_NTFY_URL or asks once; a kept file stays on re-install; the URL is never said. No URL: the file is empty, push is off.
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDen } from "./den-service.mjs";
import { createReleases } from "../build/releases.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const fakeBox = { async build({ folder }) {
  await mkdir(path.join(folder, "apps/ui/dist"), { recursive: true });
  await writeFile(path.join(folder, "apps/ui/dist/index.html"), "ui");
  return { ok: true, files: 1, bytes: 2, tail: "" };
} };
const URL1 = "https://ntfy.sh/den-secret-topic-1a2b3c";
const URL2 = "https://ntfy.example.org/den-other-topic";

describe("den:install and the ntfy push address", () => {
  let tmp, checkout, state, unitDir, lines, asked;
  const den = ({ env = {}, answer = null } = {}) => createDen({
    env: { HOME: tmp, PATH: "/usr/bin:/bin", ...env }, say: (l) => lines.push(l), node: "/usr/bin/node", repo: checkout, stateDir: state, unitDir,
    bus: { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" } }, bwrap: "/usr/bin/bwrap",
    systemctl: async () => ({ ok: true, out: "", err: "" }), answers: async () => true,
    ask: async () => (asked += 1, answer),
    releases: createReleases({ stateDir: state, repo: checkout, main: "origin/main", box: fakeBox, npm: async (cwd) => mkdir(path.join(cwd, "node_modules")) }),
  });
  const file = () => path.join(state, "ntfy-url");
  const leaked = async (url) => lines.some((l) => l.includes(url)) || (await Promise.all((await readdir(unitDir)).map((n) => readFile(path.join(unitDir, n), "utf8")))).some((t) => t.includes(url));

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-ntfy-install-"));
    const origin = path.join(tmp, "origin");
    git(tmp, "init", "-q", "-b", "main", origin);
    await writeFile(path.join(origin, "package-lock.json"), '{"name":"x","lockfileVersion":3,"packages":{}}\n');
    await writeFile(path.join(origin, "package.json"), '{"name":"x"}\n');
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "c1");
    checkout = path.join(tmp, "checkout");
    git(tmp, "clone", "-q", origin, checkout);
  });
  beforeEach(() => {
    state = path.join(tmp, `state-${Math.random().toString(36).slice(2)}`);
    unitDir = path.join(tmp, `units-${Math.random().toString(36).slice(2)}`);
    lines = [];
    asked = 0;
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  test("DEN_NTFY_URL is written at 0600 and said nowhere, and is not asked for", async () => {
    await den({ env: { DEN_NTFY_URL: URL1 } }).install();
    assert.equal((await readFile(file(), "utf8")).trim(), URL1);
    assert.equal(statSync(file()).mode & 0o777, 0o600);
    assert.equal(asked, 0);
    assert.equal(await leaked(URL1), false);
  });
  test("with no DEN_NTFY_URL it asks once; the answer is kept on re-install without asking again", async () => {
    await den({ answer: ` ${URL2} ` }).install();
    assert.equal(asked, 1);
    await den({ answer: "https://ntfy.sh/should-not-be-used" }).install();
    assert.equal(asked, 1);
    assert.equal((await readFile(file(), "utf8")).trim(), URL2);
    assert.equal(await leaked(URL2), false);
  });
  test("an empty answer keeps an empty file (push off) and is not asked again; DEN_NTFY_URL later replaces it", async () => {
    await den({ answer: "" }).install();
    assert.equal(await readFile(file(), "utf8"), "");
    await den({ answer: URL2 }).install();
    assert.equal(asked, 1);
    await den({ env: { DEN_NTFY_URL: URL1 } }).install();
    assert.equal((await readFile(file(), "utf8")).trim(), URL1);
  });
  test("with no terminal to ask on, nothing is written, so a later install asks", async () => {
    await den({ answer: null }).install();
    assert.equal(existsSync(file()), false);
  });
  test("a DEN_NTFY_URL that is not a plain http(s) URL is refused before anything changes", async () => {
    await assert.rejects(den({ env: { DEN_NTFY_URL: "file:///etc/passwd" } }).install(), /DEN_NTFY_URL/);
    assert.equal(existsSync(state), false);
  });
});
