# Backlog: enforce the one-line-comment rule across the whole codebase

**Status: not started.** This is a plan, and per CLAUDE.md plans are disposable — delete this file
when the work lands, folding anything durable into `CLAUDE.md` / the checker itself.

## The problem

CLAUDE.md's rule — *a code comment is one line; if it doesn't fit, it belongs in `docs/`* — is
enforced by `scripts/comment-lint.mjs`, but only over `src/**/*.ts`. Everything else (`test/`,
`scripts/`, config files) is outside the gate, and multi-line comment runs have accumulated there
in the hundreds. Some are legitimate fixture explanations that belong beside their fixture; some
are production-behavior narration — design and protocol knowledge that belongs in `docs/` but is
hiding in comments nobody maintains, the exact failure mode the rule exists to prevent. The two
kinds are currently indistinguishable without reading each one.

Root cause (agent-behavior diagnosis, worth keeping): **gates shape agent behavior; prose does
not.** A rule expressed as a scoped gate gets obeyed exactly to its scope — close-out audits
correctly report "comment-lint: n/a, scans only src/" and move on. If the rule should hold in
`test/` and `scripts/`, the *checker* has to say so; no amount of CLAUDE.md wording will.

## The plan

1. **Sweep before legislating.** Enumerate every 2+-line `//` run outside `src/` and classify
   each: (a) fixture quirk — legitimately co-located, keep; (b) production-behavior narration —
   rehome to the relevant `docs/` file (as a named invariant where code could silently break it,
   cited from every site that mirrors the behavior), leaving a one-line pointer; (c) padding —
   compress to one line. Given the volume, run the sweep as a fan-out (one classifying agent per
   directory, one verifying pass) rather than a single read-through. The sweep result decides the
   threshold in step 2: if legitimate fixture explanations routinely need 2–3 lines, a strict 2+
   gate would just teach agents to write one very long line.
2. **Extend `scripts/comment-lint.mjs`.** Add the swept directories to the scan with whatever
   threshold step 1 justified (likely: keep 2+ strict for `src/`, allow up to 3 lines in `test/`,
   fail 4+ everywhere). Keep the existing banner/directive exemptions. Note the current checker
   only sees `//` runs — `/** */` blocks are invisible to it; decide explicitly whether JSDoc
   stays exempt (file-header JSDoc in specs is house style) and write that decision into the
   checker's header comment.
3. **Update the prose to match the gate.** Rewrite CLAUDE.md's exemption sentence to state the
   new scope and threshold; the checker and CLAUDE.md must tell the same story or the next agent
   inherits the same split-brain.
4. **Prove the gate bites.** Temporarily plant violations at each threshold boundary and watch
   the checker fail (the repo's own "a green suite is not evidence" discipline applies to
   checkers too).

## Acceptance

- `node scripts/comment-lint.mjs` scans `src/`, `test/`, `scripts/` and is green in CI.
- CLAUDE.md's comment rule states the same scope/threshold the checker enforces.
- The sweep list is closed out: every run outside `src/` either kept (classified fixture quirk),
  rehomed to `docs/` with a one-line pointer, or compressed — none left unclassified.
