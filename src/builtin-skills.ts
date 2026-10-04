// Built-in skills shipped with smolcoder (no download needed).
// "impeccable-design" is a small-model adaptation of the official skill
// pbakaus/impeccable skill/SKILL.src.md (Apache-2.0, https://github.com/pbakaus/impeccable).
// The full launcher workflow (impeccable context binary, craft-floor,
// reference playbooks) lives upstream; this built-in keeps the rules a local
// model can actually apply with read/edit/run_command/task: pick a visitor
// mode, honor the brief, verify in bounded passes, then stop polishing.

export const BUILTIN_SKILLS: Record<string, string> = {
  "coding-workflow": `coding-workflow (built-in).
Use for implementation requests that change project code.
- Read the repository instructions and inspect the exact files and call sites before editing.
- Turn multi-step work into a short, concrete plan; keep unrelated cleanup out.
- Make the smallest complete change that satisfies the requested behavior.
- Use the repository's existing tools and patterns; do not claim to have run a command or changed a file unless it actually happened.
- Run the narrowest relevant tests, then build/type-check when the change affects compiled code.
- Report changed files, actual command results, and anything that remains unverified.
`,
  "bugfix-workflow": `bugfix-workflow (built-in).
Use for bug reports and regressions.
- Reproduce the reported behavior or write a failing regression test before changing implementation.
- Trace the failure to its owning code path; fix the cause rather than hiding the symptom.
- Keep the patch narrow and preserve existing behavior outside the defect.
- Re-run the reproducer and relevant regression tests; do not call a failed or skipped check a pass.
- State any environment-dependent behavior that could not be verified.
`,
  "code-review-workflow": `code-review-workflow (built-in).
Use for code review, audit, and quality inspection.
- Review the actual changed code and relevant callers, tests, and failure paths.
- Report only actionable issues supported by concrete file/line evidence.
- Prioritize correctness, data loss, security, and user-visible regressions; omit style-only preferences.
- If no actionable issue is established, say so instead of inventing findings.
`,
  "workspace-investigation": `workspace-investigation (built-in).
Use for requests to inspect or diagnose a project without modifying it.
- Read repository guidance first, then inspect the paths and callers relevant to the question.
- Use search and bounded file reads; follow evidence across interfaces instead of inferring from names.
- Separate confirmed findings from hypotheses and include concrete paths and observed behavior.
- Do not edit files or claim a complete audit when only a subset was inspected.
`,
  "documentation-workflow": `documentation-workflow (built-in).
Use for project documentation changes.
- Check the implementation and existing documentation conventions before editing.
- Keep examples and commands consistent with the current code; verify referenced paths and scripts.
- Make focused edits and run documentation checks when the repository provides them.
- Distinguish verified instructions from assumptions or platform-specific caveats.
`,
  "direct-style": `direct-style (built-in, adapted from i-have-adhd SKILL.md, MIT).
Shape every response so it can be acted on immediately.
- Lead with the next action: command, path or snippet first, prose after.
- Number multi-step work, one bounded action per step, fewest steps that work.
- End with one concrete next action doable in under two minutes.
- Restate state every turn ("step 3 of 5 done, next: ...").
- Time estimates in concrete units ("15 minutes", never "a bit").
- Show what now works with a command to try it.
- Errors: file:line, cause, fix — no "uh oh".
- Cap lists at 5 items per group; analysis stays complete.
- No preamble, no recap, no closers. Start with the answer, stop when done.
These rules persist for the whole session; "normal mode" turns them off.
`,
  "impeccable-design": `impeccable-design (built-in, adapted from pbakaus/impeccable, Apache-2.0).
Use for frontend interface work only: design, redesign, critique, audit, polish, layout, color, typography, error states, empty states, responsive. Never for backend-only tasks.

Visitor mode (pick from the surface, not the product):
- Persuade: visitor decides and acts (landing, pricing, marketing). Earn attention.
- Operate: visitor completes a task (dashboard, settings, admin). Scanability first.
- Read: visitor understands (docs, guides). Structure for comprehension.
- Experience: visitor is inside the work (portfolio, gallery). Artifact leads.

Rules:
- The brief wins: pinned fonts, palettes, eras stay even against habit.
- Refinement preserves identity and copy; redesign replaces the look but keeps product truth. Never blend into polish on a discarded look.
- Deliverable complete: no TODO, no placeholder, no lorem ipsum.
- Verify in bounded passes: build, inspect once (dev server + web preview, desktop and mobile), fix everything in one batch, confirm once, stop.

Workflow:
1. Read the target page/component and its current styles before editing.
2. Pick the visitor mode and name it in one line.
3. Make the smallest edit that carries the mode; keep tokens/CSS consistent.
4. Run the build (and tests when present); open the preview and read real output.
5. Fix the batch, re-verify once, summarize what changed and how it was checked.
Mini-commands: shape (plan first), critique (review), audit (a11y/perf/responsive basics), polish (final pass), harden (errors/empty/i18n), adapt (mobile), clarify (copy).
`,
};
