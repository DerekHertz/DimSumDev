# The den serves itself from release folders: preview, go live, roll back, update

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** proposed (den-mvp outcome 5, `.scratch/den-mvp/spec.md` section 7). Part A is built by the first PR and Part B by the second; the user accepts each by merging its PR. It amends ADR 0024: decision 1 (what makes a delivery visual), decision 5 (new pauses, and what a decline does) and adds a step after the merge. It amends ADR 0017 Amendment 1 in one point (a meeting holds its ticket).

**Context.** Until now the user starts the bridge by hand (`npm run ui`), and it runs its own code and serves `apps/ui/dist` straight from the main checkout. So the running den changes whenever the checkout does, a UI change cannot be looked at before it is merged, nothing keeps the bridge up, and a bad build is undone in a terminal. The spec asks that "a functional change is previewed, approved, delivered, served, and recoverable without terminal coordination", with a supervisor "outside the bridge's own process".

The spec leaves the design open. Every choice below marked **(user)** was put to the user in a grilling session on 2026-10-13 and is their answer. The rest follows from those answers, the spec or the code, and is marked where it is still unchecked.

## Decision

## Part A: the frontend (first PR)

### 1. Release folders

**(user)** The running den runs from release folders outside the checkout. They live beside the existing per-project state, under `$XDG_STATE_HOME/den/` (default `~/.local/state/den/`):

| Path | Holds |
|---|---|
| `releases/<sha12>/` | a complete copy of one commit of `main` (`git archive`, no `.git`), the UI built from it in `apps/ui/dist`, and `build.json` |
| `deps/<lock-hash>/node_modules` | the packages for one `package-lock.json`, installed once |
| `ui/current`, `ui/previous` | links to the release whose UI is served, and the one before it |
| `bridge/current`, `bridge/previous` | links to the release whose bridge code runs, and the one before it |
| `previews/<job id>/` | one candidate's copy and its build |

- `build.json` (`{ sha, builtAt, lock }`) is written last. A folder without it is not a release: it is never served and is removed at start.
- A link is switched by making a new link and renaming it over the old one, so a reader sees one release or the other.
- (den-mvp/16) A release and a preview are both made by the same `extractArchive` (`git archive` of the commit, read with that commit's own `.gitattributes`), so `export-ignore` and `export-subst` act identically on both and the live release cannot differ from the preview on that account; `.gitattributes` has none today. Two processes making or switching releases on one state folder take lock files (`releases.lock`, `making-<sha12>.lock`) under it.
- Two releases are kept per pair, current and previous. A release no link points to is deleted.
- The UI and the bridge have separate links because a UI change goes live without a restart, and a bridge change does not (Part B).
- The project root stays the checkout: the board, the worktrees and the role files are read from there. What the bridge reads beside its own code (the guardrail files in `apps/bridge/cells/`) now comes from the release, that is, from a merged commit. **To check during the build:** list everything the bridge reads and say which side each is on.

### 2. The build box

A UI build runs the repository's own code (`apps/ui/vite.config.mjs`, its plugins, the packages). For a preview that code is a candidate no one has reviewed. So the bridge never builds in its own process. `apps/bridge/build/box.mjs` runs one fixed command, `vite build` with the UI's config, inside bubblewrap:

- no network, its own process and user namespaces, and it ends with the bridge;
- it can write the folder's `apps/ui/dist` and a private `/tmp`, and nothing else. The rest of the build folder is read-only: a release's folder also holds the bridge code the service runs, so a build that could write there could change it;
- it can read the build folder, the Node binary, the system libraries and one `deps/<lock-hash>/node_modules`, and nothing else: not the home directory, the checkout, the board or any login;
- a cleared environment;
- it is started through the same resource-group launcher as an agent run, and is refused when that launcher refuses.

There is no fallback. When bubblewrap or the resource group is missing, a preview or a go-live is refused with the blocker named (spec: "missing enforcement is a startup refusal, never an unsandboxed fallback"). Both the preview build and the go-live build use the box. Stop on the delivery ends a build, and so does the time limit below. What comes out is bounded in file count and total size, and only regular files are served: a link in the output is refused. (den-mvp/16) A build that does not finish within 20 minutes is stopped and refused with code `build`, and builds run one at a time in the bridge (a second waits for the first). No seccomp filter is added: bubblewrap takes only a compiled BPF program (`--seccomp FD`), the box has no way to build one without a seccomp library, which would be a new dependency, and the namespaces, the dropped capabilities and the resource group already bound what the build can do.

**To check during the build:** which limits a build runs under without changing `limits.json` (a new class there is a guardrail change, prepared as a patch for the user); that bubblewrap can make its namespaces from inside the service.

### 3. Packages

`deps/<lock-hash>` is made by `npm ci --ignore-scripts` in a temporary folder that is then renamed. That needs the network, so it happens only on the user's action: the install command (decision 4), and from Part B the Update button. `package-lock.json` is on the user-merge list, so it changes only by the user's own merge. A candidate or a merged commit whose lockfile has no `deps` folder gets no build; the den says the den must be updated first. **Unchecked:** that the UI builds from packages installed with `--ignore-scripts`.

### 4. The service

**(user)** A systemd user service keeps the bridge running, and it arrives in the first PR. **(user)** Containers come later: a ticket after outcome 6 puts the bridge in one; release folders map onto image tags.

- `apps/bridge/service/den.service` is a template. `npm run den:install`, run once by the user, fetches `main`, makes the packages folder and the first release, sets all four links, writes the unit to `~/.config/systemd/user/` and enables it.
- The unit runs `node <state>/bridge/current/apps/bridge/server.mjs` with the checkout as its working directory, in `den.slice`, on port 4317, restarted when it fails. It names the state folder to the bridge (`DEN_STATE_DIR`), so the bridge serves the releases `den:install` made whatever `XDG_STATE_HOME` was in the installing shell.
- No agent and no bridge route installs, enables or edits the unit. Installing the service is the user's act.
- `npm run den:update`, also the user's, makes a release from the current `main` and restarts the service. In Part A it is the only way new bridge code starts running; Part B puts a button in front of the same steps.
- `npm run bridge` from the checkout still works for development, on another port.
- Linux and WSL only. On a host without systemd or bubblewrap the den runs as before from the checkout, and previews and go-live are refused.

### 5. The preview

**(user)** Every delivery whose candidate changes a path under `apps/ui/` gets a preview and waits for the user. **(user, after the security review)** So does one that changes `packages/`, which the UI build bundles; a test walks the UI's imports and fails when a file outside these paths (and outside the paths only the user merges) is bundled. **(user, after the security review)** Security reviews every such change before its preview, whatever the scripted check said: the code will run in the den's page with the user's session, and a preview shows how it looks, not what it does. A delivery is visual when its ticket type is visual (as before) or its changed paths say so. **(user)** Each waiting delivery has its own preview. **(user)** A preview shows the live den and can change nothing.

- After qa `verify`, the checks and (on a hit) security have passed for the candidate commit, the bridge copies that commit into `previews/<job id>/` and builds it in the box. The evidence is `preview: { sha }` and, like all evidence, counts only while that commit is the candidate.
- A build that fails goes back to the developer as a failed check, with the last lines of the build output. A box that cannot run is an `environment` pause.
- The bridge opens one more listener per preview on `127.0.0.1`, on a port the system picks. A separate port is a separate origin, and the den's login is a bearer token held by the den's own page, so the preview's code cannot read it. That is what makes "actions off" enforceable.
- The preview listener serves the built files and a fixed list of read routes: the snapshot, the event stream and the library. The list is written out in `routes.mjs`; "every GET" is not the rule. Every other request is a 403 on that listener, which has no path to a handler that changes anything. **(user, after the security review)** A preview has no token, so the reads that need one on the den (a meeting, a conversation) are not offered there, and the snapshot and the event stream it gets leave out transcripts and permission requests: what a preview can read, it can carry away. **(user, after the second security review)** What a preview gets is a list of what it may see, not a list of what is hidden: an agent comes without its reply, its tool call and its reason, and a snapshot key, an agent field or a kind of change that nobody listed does not reach a preview.
- The preview's pages carry a content security policy with `connect-src 'self' blob:` (the den's models load their textures from blobs the page makes; a blob is not a network address), no forms and no frames, so unreviewed code cannot send what it reads to the live den's port or to the network by a request. A policy cannot stop a page from navigating itself to another address; that is left to the reviews the candidate passed before its preview was built.
- The listener checks `Host` and `Origin` for its own port, as the den's does.
- A preview closes when the verdict is given, the delivery is closed, or the bridge stops. After a restart it is served again from its folder if its record still names the candidate commit.
- In the den the page shows as not signed in to steer: the existing disabled state, no new one.

### 6. Approve, decline, go live

**(user)** One approval covers everything after it: the push, the pull request, the merge on green checks, and going live. Red checks stop it as today and nothing goes live.

**(user)** Decline sends the change back to the developer with the user's note, and a new preview follows. Declines are counted apart from failed checks and never cause `failed-twice`.

**(user)** What goes live is rebuilt from `main`. After the merge the bridge fetches `main`, checks the merge commit is on it, makes `releases/<sha12>/` from that commit in the box, and switches `ui/current` to it.

- If the build fails, the merge stands, nothing goes live, and the delivery pauses as `go-live-failed` with the reason.
- The ticket is resolved after the go-live, so a delivery that waits as `go-live-failed` or `needs-update` leaves its ticket open until Resume finishes it.
- A merge that an already live release contains is not put in front of it: the switches of the UI links run one at a time, and an older go-live is done when a later one is live. A build is made outside that queue, so a roll back never waits behind one. **(user, after the second security review)** Nothing is built inside the queue either. The bridge keeps a release it has built until its switch, whatever other switch runs first; a release that is gone all the same (another process cleaned up) fails the go-live, which is tried again.
- The UI imports from the bridge's code. So the UI goes live alone only when nothing under `apps/bridge/` and no lockfile differs between the running bridge's release and the new commit. Otherwise the delivery pauses as `needs-update`: the den must be updated first (decision 4 in Part A, the button in Part B), and Resume then finishes the go-live.
- A delivery that changes nothing under `apps/ui/` makes no release.

### 7. Roll back

**(user)** Rolling back is a button and the user's call; nothing rolls back by itself. **(user)** `main` is left alone.

- `POST /build/rollback { to }` (token-gated) switches `ui/current` and `ui/previous`. `to` names the release the button showed; a different `ui/previous` is a 409. Rolling back twice returns to where it started.
- The bridge also serves a plain page, `/recover`, from its own code and not from the UI build, with the same button. It works when the new UI does not load.
- The snapshot gains `build: { live: { sha, at }, previous, rolledBack }`. After a roll back the den shows that the live build is behind `main`, and the next approval card says that going live will bring the rolled-back change with it.

### 8. Open tabs

**(user)** A tab that is open during a switch keeps working and shows "A new version is ready" with a Reload button.

- The bridge sends a `build` frame on a switch; the page compares it with the build it was made from.
- A hashed file not found in the current release is looked for in the previous one, so an old tab can still load its parts. `index.html` always comes from the current one. A tab older than the previous release has to reload.

### 9. The proof

**(user)** The first change through the path shows which build is live (short commit, and when it went live). **(user)** The v5 visuals (`D:\dimsumden-mockups-v5`) are the first real change delivered through it from the den, in their own PRs.

## Part B: the bridge (second PR)

Decided in outline. The detail is settled when this part is cut into tickets.

1. **(user)** The user merges a bridge change on GitHub, as the spec requires for the den's own enforcement. The den then shows "Update the den" with what changed, and nothing restarts until the click. The click is the approval for that update and nothing wider.
2. **(user)** On the click the bridge makes the release, stops admitting new runs, and waits for the running ones to end, for as long as they take. A "Restart now" button stops them. Stopped work pauses and needs the user's Resume afterwards, as after any restart.
3. The bridge never calls the service manager. It records the release to start and exits; the service starts it. A small launcher, installed by `den:install` and not part of any release, starts the new release and checks that it answers.
4. **(user)** If the new bridge does not answer, the launcher starts the previous release and the den shows that the update failed and why.
5. Part B changes the unit, so the user runs `den:install` once more.

## Decided with this, built on their own

- **(user)** A meeting holds its ticket from its first take until its brief is written, it pauses or it is stopped; the bridge refuses any other run on that ticket meanwhile.
- **(user)** Meeting seats stay the seven specialists; Bao chairs and scout is not seated.
- **(user)** Needs you gets Approve and Decline for a ticket at `ready-for-human`. What Decline does to the ticket is not decided yet.

## Consequences

- An edit in the checkout no longer changes the running den. Seeing a bridge change means merging it and updating.
- The den has one more thing that runs code: the build box. It is stricter than an agent's wall (no network, no home directory), and it is new kernel surface, so it gets a security review.
- A preview is unreviewed code in the user's browser. Its origin, its token, its route list and its content policy are what stand between it and the den; each has a test.
- Until Part B, every merged bridge change means one terminal command (`npm run den:update`) before the next UI change can go live.
- Releases and packages use disk: two releases and the package folders in use.

## Not done here

- macOS, and containers.
- A preview for a change that also alters the lockfile.
- Automatic roll back, and reverting `main` after a roll back.
- Target projects (outcome 6): this is the den's own code and UI only.

## Amendment 1 (2026-10-17): updates apply themselves when the den is idle

**Status:** proposed; the user accepts it by merging the PR that carries it. It replaces Part B decision 1 ("nothing restarts until the click") and the part of den-mvp/45 that made the user's Approve the only way to tag a release. The other Part B decisions stand, with the changes below.

**Context.** After Part A every merged bridge change still needs the user to run `npm run den:update` in a terminal before it runs. The user asked (2026-10-17, question tool) for updates to go out through a deployment instead. Tags already exist (den-mvp/44), Bao drafts releases (den-mvp/45), and Part B was only decided in outline.

**Decisions** (all **(user)**, 2026-10-17, question tool):

1. **The merge is the approval.** A bridge change reaches `main` only by the user's own merge (ADR 0024: the bridge never merges its own bridge changes). So that merge is the approval for the update that follows; no second click is needed. This replaces Part B decision 1.
2. **The bridge tags patch releases.** When a commit that changes bridge or service code lands on `main`, the bridge cuts the next patch tag (`v<major>.<minor>.<patch+1>`) and publishes the GitHub Release, with notes from the merged PRs (`mergedSince`). A merge that changes only docs or the UI does not get a tag: a UI-only change already goes live without a restart (Part A). A minor or major bump is still a Bao proposal that the user approves (den-mvp/45). No agent can tag; the bridge does, with its git-host login. The tag is cut only for a commit that is on `main` and was merged by the user's own login.
3. **Tags are the unit of update.** The den updates to the newest tag. The running version comes from the release's `build.json`; `package.json`'s `version` is no longer kept equal to the tag (a tag cut by the bridge makes no commit).
4. **The update builds in the background and applies when idle.** The bridge builds the new tag's release in the box without switching (Part A decision 2 still holds), shows "vX.Y.Z ready" with what changed, and then **drains**: it stops admitting new runs, lets the running ones finish for as long as they take, records the release to start, and exits. An auto-update toggle in the den (on by default) turns this off; with it off, "Update now" does the same drain on a click. "Restart now" stops the running work, which pauses and needs Resume, as in Part B decision 2.
5. **The launcher starts the release (Part B decisions 3 to 5, unchanged).** The bridge never calls the service manager. A small launcher installed by `den:install`, and not part of any release, starts the release the bridge named and checks that it answers. If it does not, the launcher starts the previous release and the den says the update failed and why. A failed update turns the auto-update toggle off until the user turns it on, so a bad tag cannot loop.
6. **One more `den:install`.** The unit changes (it runs the launcher), so the user runs `den:install` once more. After that `den:update` is only a manual fallback.

**To check during the build.** Which paths count as "bridge or service code" (start from `apps/bridge/`, the scripts the bridge runs, `package.json` and the lockfile; the list lives in one place with a test). How the bridge learns of a merge on `main` (polling the git host, as `ci-watch` does). What "merged by the user" is checked against.

**Consequences.**

- The user no longer runs a command per bridge change. The cost is that a merge to `main` that touches bridge code is now also a deploy, so a bad bridge merge restarts the den onto it. The launcher's rollback and the toggle are the brake.
- While an update is draining, new runs wait. With long runs that can be long; "Restart now" is the escape.
- `den:update` keeps working by hand, to a tag, to `--main`, and for a rollback.
