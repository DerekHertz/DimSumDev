---
name: browser-verify
description: "Drive the den's UI in a real browser through a flow: screenshots, errors, perf trace, repro steps. Use to check a UI change."
---

# Browser verify

`npm run verify:ui` starts the server, drives Chromium through your flow, shuts everything down and returns evidence. It reports facts; you judge them. The user still judges look and feel from the screenshots you attach.

## Run

1. Write a flow, a JSON file of steps (put it under `.verify/` or your scratchpad, not in the repo unless the ticket adds it):

   ```json
   { "name": "work-queue", "steps": [
     { "goto": "/#code={launchCode}" },
     { "click": "[data-rail=work]" },
     { "waitFor": "[data-overlay=teams] .queue-row" },
     { "screenshot": "work-queue" } ] }
   ```

   Steps, one action each: `goto`, `click`, `fill {selector,value}`, `press`, `waitFor`, `expectText {selector,text}`, `wait` (ms), `screenshot` (a file name). A step that cannot run is a finding, and the flow stops there.

2. Run it:

   ```bash
   npm run verify:ui -- --den --flow .verify/work-queue.json
   ```

   `--den` builds the UI and serves it on a fixture board (`--skip-build` reuses the last build). Without it the repo is served as static files (`goto` takes a repo path); `--url <base>` drives a server already running. `--timeout <ms>` caps the run (default 120000): past it the run is a `timeout` finding and no browser or server is left behind. Inside an agent container the browser comes from the image; nothing on the host is used.

3. Read the summary or `<out>/report.json` (`--json` prints it). Exit 0: no findings. Exit 1: findings, each with a kind (`page-error`, `console-error`, `request-failed`, `http-error`, `step-failed`, `timeout`) and `reproduce` steps. Exit 2: bad flow or no browser; report that as an environment issue.

## Judge

- Each finding is a bug to fix or a reason it is not one; say which in your handoff.
- Open the screenshots and check them against the criterion. A clean run proves the page loaded and the flow ran, not that it looks right.
- Put the screenshot paths and the perf line (load time, trace path) in the handoff.
- Never loop a flaky run until it passes. Report it.

Run a browser test file only through `npm run test:path -- <file>`, which caps browsers at a few at once.
