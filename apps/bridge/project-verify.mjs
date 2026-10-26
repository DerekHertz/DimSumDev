// multi-project/03: reads main's branch protection through the bridge's gh login and, when the policy's required checks are
// missing, prints the gh api PUT command for the user to run. It only reads (GET); it never applies protection.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const TEMPLATE = new URL("../../docs/agents/branch-protection-main.json", import.meta.url);

/** The body for `gh api -X PUT`, from the den's template with the target's check names. */
export async function protectionBody(checks) {
  const body = JSON.parse(await readFile(TEMPLATE, "utf8"));
  const appId = body.required_status_checks.checks[0]?.app_id;
  body.required_status_checks.checks = checks.map((context) => ({ context, app_id: appId }));
  return body;
}

/** -> { ok: true } when main requires every check, else { ok: false, missing, command }. */
export async function verifyProtection({ repo, checks }, { gh = (args) => execFileP("gh", args).then((r) => String(r.stdout)) } = {}) {
  let have = [];
  try {
    const data = JSON.parse(await gh(["api", `repos/${repo}/branches/main/protection/required_status_checks`]));
    have = [...(data.contexts ?? []), ...(data.checks ?? []).map((c) => c.context)];
  } catch {
    have = []; // 404: main is not protected
  }
  const missing = checks.filter((c) => !have.includes(c));
  if (missing.length === 0) return { ok: true };
  const body = JSON.stringify(await protectionBody(checks));
  return { ok: false, missing, command: `echo '${body}' | gh api -X PUT repos/${repo}/branches/main/protection --input -` };
}
