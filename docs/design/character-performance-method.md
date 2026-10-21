# Character performance method

How a new den character passes its performance budget. Decided by the user on 2026-10-20 on team-and-den-ux/24 (Bao). It applies to every character in 25–34 and to 35's full-cast check.

## The rule

A character passes on its **structural budgets**, checked by tests against the shipped asset:

| Budget | Limit |
|---|---|
| Triangles, props included | target 8,000, hard cap 12,000 |
| Main-pass draws | ≤ 6 |
| Shadow-casting triangles | ≤ 8,000 |
| Bones | ≤ 32 |
| Geometry bytes per actor | ≤ 2 MiB |
| Colour atlas | one 512² colour map, no normal or roughness maps (≈1,398,100 bytes of texture storage with mips) |
| Portrait | ≤ 40 KiB |

Bao's checks are in `apps/ui/src/scene/meshy/bao-production.test.mjs`; the 23 proof characters' are in `character-rig.test.mjs`. A new character adds the same assertions for its own asset.

The atlas is an allowance the user grants per character, as for Bao. Every other limit holds without one.

## Why not frame timing

The original criterion also asked for a matched frame-time comparison on this box. It can't decide here. On WSL with the GPU through `/dev/dxg`, an A/A control with identical assets on both sides differed by −29% in GPU median (commit `faca60b` on the archived `codex/bao-24` branch, `docs/research/team-and-den-ux-24/identical-control.md`; the measurement harness stays on that branch, out of main), which is larger than any per-character difference worth judging. Five more diagnostic rounds found no cause. The structural limits are what a per-character budget controls, so they are the gate.

Timing comes back as a gate only if a quiet box (or freed memory here) gets an A/A spread below 5%.
