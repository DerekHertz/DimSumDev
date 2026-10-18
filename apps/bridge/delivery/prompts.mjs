// den-mvp outcome 3 (spec section 4): the prompt of one delivery step. A fixed template over fields the bridge made
// itself (role, mode, ref, the ticket's path, a commit id); no client string and no agent text reaches it. A step's
// agent writes nothing on the board and publishes nothing: the bridge claims the ticket, writes the handoff from the
// run's last message, releases, pushes and opens the pull request. A reviewer's verdict is one line of that message.
export const VERDICT_RE = /^[ \t>*_`-]*VERDICT:[ \t]*(pass|bounce)\b[ \t*_`.]*$/gim;

// den-mvp: what the user should look at on a preview. A developer report ends with a `Look at:` line and a list under it.
const LOOK_AT_RE = /^[ \t>*_`#-]*look at[ \t*_`]*:[ \t*_`]*(.*)$/im;
const LOOK_AT_MAX = 6; // items
const LOOK_AT_ITEM_MAX = 200; // characters of one item

/** The items of a report's last `Look at:` list, each one line of plain text; [] when there is none. */
export function readLookAt(report) {
  if (typeof report !== "string") return [];
  const lines = report.split(/\r?\n/);
  let at = -1;
  lines.forEach((l, i) => { if (LOOK_AT_RE.test(l)) at = i; });
  if (at < 0) return [];
  const items = [];
  const first = LOOK_AT_RE.exec(lines[at])[1].trim();
  if (first) items.push(first);
  for (const l of lines.slice(at + 1)) {
    const m = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.+)$/.exec(l);
    if (m) items.push(m[1].trim());
    else if (l.trim() !== "" || items.length > (first ? 1 : 0)) break; // a blank line between the label and the list is fine
  }
  return items.slice(0, LOOK_AT_MAX).map((s) => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").slice(0, LOOK_AT_ITEM_MAX)).filter((s) => s.trim());
}

/** The last verdict line of a report, or null. */
export function readVerdict(report) {
  if (typeof report !== "string") return null;
  const found = [...report.matchAll(VERDICT_RE)].at(-1);
  return found ? found[1].toLowerCase() : null;
}

// The den's friction log (.scratch/den-mvp/friction.md, F2 and F4): what a walled run cannot do, said before it tries.
export const WORK_TIPS =
  "Run every check in the foreground under `timeout` (a command may take up to 10 minutes), never in the background: you have no tool to wait for a background run, and `sleep` before a command is blocked. " +
  "For a check longer than 2 minutes, also set the Bash tool's own timeout (up to 600000 ms), or it moves the command to the background. " +
  "Run `node --test` with `--test-concurrency=2`: every thread counts toward your process limit, and a run over it is stopped. " +
  "Put a throwaway script under .den/ in this worktree (git ignores it), not in $TMPDIR: Node finds the repository's packages only from inside the worktree. " +
  "Stage files by name (`git add <paths>`), never `git add -A` or `git add .`: the sandbox leaves placeholder files such as .bash_profile that git cannot add. " +
  "`gh` has no login behind the wall: read pull requests, checks and CI job logs with the GitHub connection's tools (mcp__github__*) when your role has them. " +
  "Before adding or bumping a package, check it with Socket (mcp__socket__depscore) when your role has it. " +
  "For how a public library works inside, ask DeepWiki (mcp__deepwiki__ask_wiki_question, owner/repo) after context7's docs. ";

const SHARED =
  "The den's bridge runs this delivery: it has claimed the ticket for you, and it will write your handoff to the board and release the ticket when you end. " +
  "Run no board command, and do not push, open a pull request or merge: the bridge does each of those from the commit it records. " +
  WORK_TIPS;

/** { role, mode?, ref, ticketFile, since, fix?, note? } -> the step's prompt. `since` is the commit the delivery started from. */
export function deliveryPrompt({ role, mode, ref, ticketFile, since, fix = false, note = false, guard = false }) {
  const head = `You are the ${role} cell${mode ? ` in ${mode} mode` : ""} for ticket ${ref}. Read .claude/agents/${role}.md for how to work, with these changes. ${SHARED}The ticket is the file ${ticketFile}. ${note ? "The user left you a note when they resumed this delivery: it is at the top of .den/findings.md. Read it first and follow it. " : ""}`;
  if (role === "developer") {
    return (
      head +
      (fix ? "A review of the last commit asked for changes: read .den/findings.md first, and fix what it names. " : "") +
      "Work test-first in this worktree, run the checks that cover your change (the full suite runs on the pull request), and commit your work here: the bridge publishes the branch from your last commit, and a run that commits nothing delivers nothing. " +
      "End with a short report of what you changed and which checks you ran and what they showed: that last message is your handoff. " +
      "If the change alters what the den looks like, end the report with a `Look at:` line and a list under it: for each visible change, one line saying where in the den to find it and what should look different. The user reads that list beside the preview."
    );
  }
  const guardNote = guard ? "The bridge's test guard flagged changes that may weaken the tests: they are listed in .den/findings.md under 'Test guard'. For each one, say in your findings whether you accept it and why, or bounce it. " : "";
  const scope = role === "security" ? "for security: what it lets an agent, a request or untrusted text do that it could not do before" : "against the ticket's acceptance criteria, independently of the developer's own report";
  return (
    head +
    `Review the commit checked out here ${scope}. The change is \`git diff ${since}..HEAD\`. Run the checks that cover the change yourself; the full suite runs on the pull request, so do not run it here. ` +
    guardNote + "Change no file and commit nothing: a review that moves the commit is not counted. " +
    "End with your findings, each one concrete enough to fix, and then, on a line of its own, `VERDICT: pass` or `VERDICT: bounce`. That last message is your handoff."
  );
}
