// Test-only helper (no .test.mjs suffix): a GitHub host in memory, the few `gh` calls the GitHub board makes.
// A GitHub host in memory: the few `gh` calls the adapter makes, over labels, comments and state.
export function fakeGh(login = "den-bot") {
  const issues = [];
  const calls = [];
  const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const exec = async (_file, args) => {
    calls.push(args);
    const [a, b, n] = args;
    const issue = issues.find((i) => String(i.number) === n);
    if (a === "api") return { stdout: `${login}\n` };
    if (b === "list") return { stdout: JSON.stringify(issues) };
    if (b === "view") return { stdout: JSON.stringify(issue) };
    if (b === "create") {
      issues.push({ number: issues.length + 1, title: flag(args, "--title"), body: flag(args, "--body"), state: "OPEN", comments: [], labels: flag(args, "--label").split(",").map((name) => ({ name })) });
      return { stdout: `https://github.com/o/r/issues/${issues.length}\n` };
    }
    if (b === "edit") {
      const off = (flag(args, "--remove-label") ?? "").split(",");
      issue.labels = issue.labels.filter((l) => !off.includes(l.name));
      if (flag(args, "--add-label")) issue.labels.push({ name: flag(args, "--add-label") });
    }
    if (b === "comment") issue.comments.push({ author: { login }, body: flag(args, "--body") });
    if (b === "close") { issue.state = "CLOSED"; issue.comments.push({ author: { login }, body: flag(args, "--comment") }); }
    return { stdout: "" };
  };
  return { issues, calls, exec, login };
}
