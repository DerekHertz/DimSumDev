// team-and-den-ux/01 (ADR 0028): the old spellings keep working for one release.
// `--cell <role>` becomes `--role <role>`, with one line on stderr naming the new spelling.
export const LEGACY_FLAGS = { "--cell": "--role" };

export function normalizeLegacyFlags(argv, name, warn = (line) => process.stderr.write(line + "\n")) {
  const told = new Set();
  return argv.map((arg) => {
    const [flag, ...value] = arg.split("=");
    const next = LEGACY_FLAGS[flag];
    if (!next) return arg;
    if (!told.has(flag)) warn(`${name}: ${flag} is deprecated; use ${next} (ADR 0028)`);
    told.add(flag);
    return value.length ? `${next}=${value.join("=")}` : next;
  });
}

// A row written before the rename names its role in `cell`; new rows use `role`.
export const roleOf = (row) => (row == null ? undefined : row.role ?? row.cell);
// A usage row from one agent's run: kind:"agent", or kind:"cell" before the rename.
export const isAgentRow = (row) => row?.kind === "agent" || row?.kind === "cell";
