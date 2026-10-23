// hardening/16: the den's own Claude logins, apart from the interactive CLI's. Each lives in <den state>/accounts/<name>.
//   npm run den:account -- add <name>    opens `claude` with CLAUDE_CONFIG_DIR there; type /login, then /exit
//   npm run den:account -- list          the accounts, the active one starred
// Switching is a POST to the bridge's /accounts/active route (no button in the den yet). A running den picks a new account up within a minute.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { activeAccount, addAccount, listAccounts } from "../apps/bridge/proxy/accounts.mjs";

const stateHome = path.isAbsolute(process.env.XDG_STATE_HOME ?? "") ? process.env.XDG_STATE_HOME : path.join(homedir(), ".local", "state");
const stateDir = path.isAbsolute(process.env.DEN_STATE_DIR ?? "") ? process.env.DEN_STATE_DIR : path.join(stateHome, "den");
const [cmd, name] = process.argv.slice(2);

const login = ({ env }) => new Promise((resolve, reject) => {
  console.log(`In the claude that opens, type /login and sign in, then /exit. Account: ${name}`);
  const child = spawn(process.env.DEN_CLAUDE_BIN || "claude", [], { env: { ...process.env, ...env }, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", resolve);
});

try {
  if (cmd === "add") {
    const { dir } = await addAccount({ stateDir, name, login });
    console.log(`added ${name} (${dir})`);
  } else if (cmd === "list") {
    const active = await activeAccount({ stateDir });
    for (const n of await listAccounts({ stateDir })) console.log(`${n === active ? "*" : " "} ${n}`);
  } else {
    console.error("usage: den:account -- add <name> | list");
    process.exit(2);
  }
} catch (e) {
  console.error(`den:account: ${e.message}`);
  process.exit(1);
}
