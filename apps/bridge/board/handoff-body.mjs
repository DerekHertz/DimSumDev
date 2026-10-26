// The handoff the bridge writes for a run it hands off (den-mvp outcome 3): the State block is the bridge's own record, the
// agent's last message follows as a quoted report. Both board adapters publish this one text.
const REPORT_MAX = 60000; // characters of a run's report kept in a handoff (the board caps a handoff at 256 KiB)

/** -> { name, body } for the handoff of `ref`. */
export function handoffRecord(ref, { role, mode, runId, sha, branch, verdict, report, committed = true }) {
  const [feature, ticket] = ref.split("/");
  const nn = /^(\d{2,})-/.exec(ticket)[1];
  const state = {
    ticket: ref, role, ...(mode ? { mode } : {}),
    current_step: verdict ? `${role} ${verdict === "pass" ? "passed" : "bounced"} commit ${sha.slice(0, 12)}` : committed ? `${role} committed ${sha.slice(0, 12)}` : `${role} made no commit`,
    artifacts: committed ? [...(branch ? [`branch ${branch}`] : []), `commit ${sha}`] : [], decisions: [], failures: [],
    pending: verdict === "bounce" ? [{ item: "fix the findings below", owner: "developer" }] : [],
  };
  const body =
    `# ${role} handoff for ${feature}/${ticket}\n\nWritten by the den's bridge for run ${runId}. The State block is the bridge's record; the report is the agent's last message.\n\n` +
    `## State\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\n## Report\n\n${String(report ?? "(the run left no report)").slice(0, REPORT_MAX).replace(/```/g, "'''")}\n`;
  return { name: `${nn}-${role}${mode ? `-${mode}` : ""}-${runId.slice(2, 10)}.md`, body };
}

/** The release note a handoff leaves on the ticket. */
export function handoffNote({ role, sha, verdict, committed = true, source = "den delivery" }) {
  return verdict ? `${role} ${verdict} at ${sha.slice(0, 12)} (${source})` : committed ? `committed ${sha.slice(0, 12)} (${source})` : `no commit (${source})`;
}
