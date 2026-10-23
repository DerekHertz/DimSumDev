// den-mvp outcome 4 (spec section 3, "MCP" in the testing decisions): the catalog's checks, as pure functions.
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { connectionsFor, decideTool, loadCatalog, parseCatalog, toolsOfRoleFile } from "./catalog.mjs";

const entry = (over = {}) => ({
  name: "docs", title: "Docs", purpose: "Look things up.", url: "https://docs.example.com/mcp", credential: "none",
  roles: ["sre", "developer"], tools: { find: "read", save: "change", post: "publish" }, ...over,
});
const one = (over) => parseCatalog({ connections: [entry(over)] }, { denRoot: "/den" });
const rejects = (over, why) => assert.throws(() => one(over), /connections\.json/, why);

describe("the catalog file", () => {
  test("the den's own catalog parses, and every address in it is a public https host", () => {
    const catalog = loadCatalog();
    assert.ok(catalog.connections.length >= 1);
    for (const c of catalog.connections) if (c.target.url) assert.match(c.target.url, /^https:\/\/[a-z0-9.-]+\//);
    assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.connections[0]) && Object.isFrozen(catalog.connections[0].tools));
  });

  test("a connection is a remote address or a script in the den, never both and never a command", () => {
    assert.deepEqual(one().connections[0].target, { name: "docs", url: "https://docs.example.com/mcp" });
    assert.deepEqual(one({ url: undefined, script: "apps/bridge/library/servers/test-server.mjs" }).connections[0].target, { name: "docs", script: "/den/apps/bridge/library/servers/test-server.mjs" });
    rejects({ script: "apps/bridge/library/servers/x.mjs" }, "both");
    rejects({ url: undefined }, "neither");
    // A script runs outside the shell sandbox, so only the one directory kept for them can hold one: not the bridge's own code.
    for (const script of [
      "/etc/x.mjs", "../x.mjs", "apps/x.mjs", "apps/bridge/server.mjs", "apps/bridge/library/catalog.mjs", "apps/bridge/library/servers/../catalog.mjs",
      "apps/bridge/library/servers/sub/x.mjs", "apps/bridge/library/servers/x.sh", "apps/bridge/library/servers/a b.mjs", "apps/bridge/library/servers/.mjs",
      "scripts/x.mjs", "apps/bridge/library/servers/x.mjs --flag",
    ]) rejects({ url: undefined, script }, script);
  });

  test("an address that could carry a secret, leave https or name a local or private host is refused", () => {
    for (const url of [
      "http://docs.example.com/mcp", "https://user:pw@docs.example.com/mcp", "https://docs.example.com/mcp?key=abc", "https://docs.example.com/mcp#x",
      "https://docs.example.com:8443/mcp", "https://localhost/mcp", "https://127.0.0.1/mcp", "https://10.0.0.5/mcp", "https://printer.local/mcp",
      "https://intranet/mcp", "https://[::1]/mcp", "https://docs.example.com/a/../b", "https://DOCS.example.com/mcp", "file:///etc/passwd", 7,
    ]) rejects({ url }, String(url));
  });

  test("a field the catalog does not know is an error, so a header, a token or an environment value has nowhere to go", () => {
    for (const extra of ["env", "token", "command", "args", "apiKey"]) rejects({ [extra]: "x" }, extra);
    assert.throws(() => parseCatalog({ connections: [], secrets: {} }), /connections\.json/);
    rejects({ credential: "sk-live-abc" }, "a credential value");
    rejects({ credential: "user" }, "an owner the den cannot hold yet");
  });

  test("a den-held credential needs a remote url; headers are plain X-MCP-* values and never carry a secret", () => {
    const t = one({ credential: "den", headers: { "X-MCP-Toolsets": "repos,actions" } }).connections[0].target;
    assert.deepEqual(t, { name: "docs", url: "https://docs.example.com/mcp", credential: "den", headers: { "X-MCP-Toolsets": "repos,actions" } });
    rejects({ credential: "den", url: undefined, script: "apps/bridge/library/servers/x.mjs" }, "a script cannot hold a credential");
    rejects({ headers: { Authorization: "Bearer abc" } }, "authorization");
    rejects({ headers: { "X-MCP-Toolsets": "a b" } }, "value");
  });

  test("names, roles and tools are checked", () => {
    for (const name of ["Docs", "a__b", "-a", "a_b", "", "a".repeat(40), 3]) rejects({ name }, String(name));
    for (const roles of [[], ["nobody"], ["sre", "sre"], "sre"]) rejects({ roles }, JSON.stringify(roles));
    for (const tools of [{}, { "a__b": "read" }, { find: "admin" }, { "": "read" }, ["find"]]) rejects({ tools }, JSON.stringify(tools));
    assert.throws(() => parseCatalog({ connections: [entry(), entry()] }), /used twice/);
  });
});

describe("what a role may do with a connection", () => {
  const catalog = parseCatalog({ connections: [entry(), entry({ name: "other", roles: ["qa"], tools: { peek: "read" } })] });

  test("a role is started with the connections that list it, and no others", () => {
    assert.deepEqual(connectionsFor(catalog, "sre").map((c) => c.name), ["docs"]);
    assert.deepEqual(connectionsFor(catalog, "qa").map((c) => c.name), ["other"]);
    assert.deepEqual(connectionsFor(catalog, "designer"), []);
  });

  test("a tool that is not a connection's is not this module's to answer", () => {
    for (const tool of ["Bash", "Read", "WebFetch", "mcp", undefined, 4]) assert.equal(decideTool(catalog, "sre", tool), null);
  });

  test("a read is allowed, a change or a publish is asked, by what the catalog says and not by what the tool is called", () => {
    assert.deepEqual(decideTool(catalog, "sre", "mcp__docs__find"), { kind: "allow", capability: "read", connection: "docs", tool: "find" });
    assert.equal(decideTool(catalog, "developer", "mcp__docs__save").kind, "ask");
    assert.equal(decideTool(catalog, "developer", "mcp__docs__post").kind, "ask");
  });

  test("a tool the server offers and the catalog does not name is refused, as is another role's connection and an unknown one", () => {
    for (const [role, tool] of [
      ["sre", "mcp__docs__delete_everything"], ["sre", "mcp__docs"], ["sre", "mcp__docs__"], ["sre", "mcp__docs__find__x"],
      ["qa", "mcp__docs__find"], ["sre", "mcp__other__peek"], ["sre", "mcp__blender__execute_blender_code"], ["sre", "mcp____find"],
      ["sre", "mcp__docs__constructor"], ["sre", "mcp__constructor__find"],
    ]) {
      const verdict = decideTool(catalog, role, tool);
      assert.equal(verdict.kind, "refuse", `${role} ${tool}`);
      assert.match(verdict.reason, /catalog/);
    }
  });
});

describe("the role file's tools line", () => {
  test("it names connections by connection or by tool; a file with no such line hides nothing", () => {
    const file = (tools) => `---\nname: sre\n${tools}model: haiku\n---\n\nbody mcp__body__x\n`;
    assert.deepEqual([...toolsOfRoleFile(file("tools: Read, Bash, mcp__context7, mcp__blender__get_objects_summary\n"))].sort(), ["blender", "context7"]);
    assert.deepEqual([...toolsOfRoleFile(file("tools: Read, Bash\n"))], []);
    assert.equal(toolsOfRoleFile(file("")), null);
    assert.deepEqual([...toolsOfRoleFile(undefined)], []);
  });
});

describe("socket and deepwiki (den-mvp/36)", () => {
  // Tool names checked live against both servers on 2026-10-15 (F16: names drift from the docs; DeepWiki's docs say ask_question).
  const catalog = loadCatalog();
  const roleFile = (role) => readFileSync(new URL(`../../../.claude/agents/${role}.md`, import.meta.url), "utf8");
  for (const [name, roles, tool] of [["socket", ["security", "developer"], "depscore"], ["deepwiki", ["architect", "developer"], "ask_wiki_question"]]) {
    test(`${name}: every tool is a read, given to ${roles.join(", ")}, and each of those role files names it`, () => {
      const c = catalog.connections.find((x) => x.name === name);
      assert.ok(c, `${name} is in connections.json`);
      assert.deepEqual([...c.roles].sort(), [...roles].sort());
      assert.ok(Object.values(c.tools).every((cap) => cap === "read"));
      assert.equal(c.credential, "none");
      for (const role of roles) {
        assert.equal(decideTool(catalog, role, `mcp__${name}__${tool}`).kind, "allow", role);
        assert.ok(toolsOfRoleFile(roleFile(role))?.has(name), `.claude/agents/${role}.md names mcp__${name}`);
      }
      assert.equal(decideTool(catalog, "product", `mcp__${name}__${tool}`).kind, "refuse");
    });
  }
  test("Socket's account tools (organizations, alerts, threat_feed) are not listed, so they are refused", () => {
    for (const tool of ["organizations", "alerts", "threat_feed"]) assert.equal(decideTool(catalog, "security", `mcp__socket__${tool}`).kind, "refuse", tool);
  });
});

describe("the github entry (den-mvp/33)", () => {
  const github = parseCatalog({ connections: [{
    name: "github", title: "GitHub", purpose: "Read pull requests and checks.", url: "https://api.githubcopilot.com/mcp/readonly", credential: "den",
    headers: { "X-MCP-Toolsets": "pull_requests,actions,issues,repos" }, roles: ["orchestrator", "qa", "developer"],
    tools: { get_pull_request: "read", get_job_logs: "read", get_file_contents: "read" },
  }] });
  test("a read tool is allowed and a tool the catalog does not list is refused, for a role that has it", () => {
    assert.equal(decideTool(github, "qa", "mcp__github__get_pull_request").kind, "allow");
    for (const tool of ["merge_pull_request", "create_issue", "push_files"]) assert.equal(decideTool(github, "qa", `mcp__github__${tool}`).kind, "refuse", tool);
    assert.equal(decideTool(github, "product", "mcp__github__get_pull_request").kind, "refuse");
  });
});

// den-mvp/45: Bao's release_propose is a board-class den tool, so the real catalog does not refuse it.
test("the real catalog lets Bao call mcp__den__release_propose", () => {
  const d = decideTool(loadCatalog(), "orchestrator", "mcp__den__release_propose");
  assert.ok(d && d.kind !== "refuse", JSON.stringify(d));
});
