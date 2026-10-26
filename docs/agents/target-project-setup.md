# Setting up a target project

What a run in a target project (not the den) needs before the den starts one. Design: `.scratch/multi-project/design.md`, decisions 26 and 27.

## Toolchain

A run's shell can read only its worktree and what the registry lists as the project's `toolchain`: plain absolute host paths (a short list: the read limit reopens eight paths in all, and the run itself uses about four). The usual entry is the clone's `node_modules`, built on the host by the user.

- Run `npm install` (or the project's own install) in the clone, then register the project with its toolchain and check names:

  ```
  npm run den:project -- add my-project /abs/path/to/clone --board github-issues --repo owner/name --checks build,test --toolchain /abs/path/to/clone/node_modules
  ```

  `--toolchain <path>` is repeatable (at most 8), each path must exist, and the registry stores its real path (a symlink is resolved, then refused if it is, holds or sits in the control checkout, is in `/etc` or holds a credential store). A github-issues `--repo` must be the path's `origin`. Without a toolchain the list is empty and `npm test` in a run fails.
- Then `npm run den:project -- verify my-project` reads `main`'s protection and prints the command to run when a check is missing; see `branch-protection.md`, "For a target".
- Host mode reopens each path for reads; container mode mounts it read-only at the same host path. A run cannot write it.
- A listed path that does not exist refuses the run, naming the path and this step. Nothing creates it.
- A native module built on the host loads in the container image only if it fits the image's Debian bookworm libc. If one does not, the fix is a per-project image, not a change here.
- A target run has no network: the shell has no allowed hosts and its container reaches only the API front through the proxy's `target` identity. Install dependencies on the host, not in a run.

## Ticket file

A target's board is not a file in its worktree, so the bridge writes the ticket text to `.den/ticket.md` in the run's worktree and the prompt names that path. The file is excluded from commits with the other `.den/` notes. No `.scratch/` path is created in the target, and no ticket file is mounted into a container.
