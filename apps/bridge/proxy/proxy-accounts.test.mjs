// hardening/16: the den's own Claude logins ("accounts"), listed, added and chosen by hand. qa specify. Red until apps/bridge/proxy/accounts.mjs exists.
//
// The contract, apps/bridge/proxy/accounts.mjs (state = the den's state folder, ~/.local/state/den in production):
//   accountsDir(stateDir)                       -> <stateDir>/accounts
//   listAccounts({ stateDir })                  -> sorted names of the directories under accountsDir that hold a .credentials.json
//                                                  (a login dir the one-time /login has not finished is not an account yet; a missing folder is an empty list)
//   addAccount({ stateDir, name, login })       the one step to add an account: makes <accountsDir>/<name> (mode 0700) and awaits
//                                                  login({ dir, env: { CLAUDE_CONFIG_DIR: dir } }), the interactive `claude` where the user types /login.
//                                                  Refuses a name that is not [a-z0-9][a-z0-9_-]{0,31}, an account that already exists, and a login that
//                                                  ends without writing <dir>/.credentials.json. Resolves { name, dir }.
//   activeAccount({ stateDir })                 -> the chosen name, else the first listed one, else null
//   setActiveAccount({ stateDir, name })        the user's manual switch: refuses a name that is not a listed account (the choice stays as it was);
//                                                  the choice is a file in the state folder, so it survives a restart. Resolves the name.
// The den never reads or writes ~/.claude/.credentials.json: every path here comes from stateDir (the den:account file may find the default state folder from HOME).
// Also pinned: package.json has a `den:account` script whose file exists, and README.md documents it with `add`.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountsDir, activeAccount, addAccount, listAccounts, setActiveAccount } from "./accounts.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const creds = (n) => JSON.stringify({ claudeAiOauth: { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt: 1, scopes: ["user:inference"] } });

describe("accounts", () => {
  let stateDir;
  beforeEach(async () => { stateDir = await mkdtemp(path.join(tmpdir(), "den-accounts-")); });
  afterEach(() => rm(stateDir, { recursive: true, force: true }));
  const seed = async (name, { finished = true } = {}) => {
    const dir = path.join(accountsDir(stateDir), name);
    await mkdir(dir, { recursive: true });
    if (finished) await writeFile(path.join(dir, ".credentials.json"), creds(name));
  };

  test("accounts live under <state>/accounts, one folder each; a missing folder is no accounts", async () => {
    assert.equal(accountsDir(stateDir), path.join(stateDir, "accounts"));
    assert.deepEqual(await listAccounts({ stateDir }), []);
    assert.equal(await activeAccount({ stateDir }), null);
  });

  test("a login dir without credentials is not an account; the rest are listed sorted", async () => {
    await seed("work");
    await seed("home");
    await seed("half-done", { finished: false });
    assert.deepEqual(await listAccounts({ stateDir }), ["home", "work"]);
  });

  test("the active account is the first one until the user chooses", async () => {
    await seed("work");
    await seed("home");
    assert.equal(await activeAccount({ stateDir }), "home");
  });

  test("switching by hand: the choice is kept for the next reader, and a name that is no account is refused with the old choice kept", async () => {
    await seed("work");
    await seed("home");
    assert.equal(await setActiveAccount({ stateDir, name: "work" }), "work");
    assert.equal(await activeAccount({ stateDir }), "work");
    for (const bad of ["nobody", "../home", "", undefined, "home/../work"]) {
      await assert.rejects(setActiveAccount({ stateDir, name: bad }), undefined, String(bad));
    }
    assert.equal(await activeAccount({ stateDir }), "work");
  });

  test("a chosen account that has since gone falls back to the first listed one", async () => {
    await seed("work");
    await seed("home");
    await setActiveAccount({ stateDir, name: "work" });
    await rm(path.join(accountsDir(stateDir), "work"), { recursive: true });
    assert.equal(await activeAccount({ stateDir }), "home");
  });

  describe("addAccount", () => {
    const finishLogin = async ({ dir }) => writeFile(path.join(dir, ".credentials.json"), creds("new"));

    test("runs the login with CLAUDE_CONFIG_DIR at the new dir (mode 0700), then the account is listed", async () => {
      const seen = [];
      const out = await addAccount({
        stateDir, name: "spare",
        login: async (arg) => { seen.push({ ...arg, mode: (await stat(arg.dir)).mode & 0o777 }); await finishLogin(arg); },
      });
      const dir = path.join(accountsDir(stateDir), "spare");
      assert.deepEqual(out, { name: "spare", dir });
      assert.deepEqual(seen, [{ dir, env: { CLAUDE_CONFIG_DIR: dir }, mode: 0o700 }]);
      assert.deepEqual(await listAccounts({ stateDir }), ["spare"]);
    });

    test("refuses a name that could leave the accounts folder or is not plain, before any login runs", async () => {
      let ran = 0;
      for (const name of ["../x", "a/b", ".hidden", "UPPER", "", "-lead", "x".repeat(33), "sp ace", undefined, 7]) {
        await assert.rejects(addAccount({ stateDir, name, login: async () => { ran += 1; } }), undefined, String(name));
      }
      assert.equal(ran, 0);
      assert.equal(existsSync(accountsDir(stateDir)) ? (await listAccounts({ stateDir })).length : 0, 0);
    });

    test("refuses an account that already exists, and leaves its login as it was", async () => {
      await seed("work");
      let ran = 0;
      await assert.rejects(addAccount({ stateDir, name: "work", login: async () => { ran += 1; } }), /exist/i);
      assert.equal(ran, 0);
      assert.equal(await readFile(path.join(accountsDir(stateDir), "work", ".credentials.json"), "utf8"), creds("work"));
    });

    test("a login that ends without credentials is an error, not an account", async () => {
      await assert.rejects(addAccount({ stateDir, name: "spare", login: async () => {} }), /credentials|login/i);
      assert.deepEqual(await listAccounts({ stateDir }), []);
    });
  });
});

describe("adding an account is one documented step", () => {
  test("package.json has den:account, its file exists, and README.md shows `den:account -- add <name>`", async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    const script = pkg.scripts?.["den:account"];
    assert.equal(typeof script, "string", "package.json has no den:account script");
    const file = script.split(/\s+/).find((w) => /\.mjs$/.test(w));
    assert.ok(file && existsSync(path.join(ROOT, file)), `den:account runs ${file}, which does not exist`);
    const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
    assert.match(readme, /npm run den:account -- add <name>/);
    assert.match(readme, /CLAUDE_CONFIG_DIR|\/login/, "the doc should say what the step does");
  });

  test("the den:account file never names the user's own .claude folder", async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    const file = pkg.scripts?.["den:account"]?.split(/\s+/).find((w) => /\.mjs$/.test(w));
    assert.ok(file, "package.json has no den:account script");
    const src = await readFile(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(src, /["'`]\.claude["'`]|\.claude\/\.credentials/);
  });
});
