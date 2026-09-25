// Built-in skills shipped with smolcoder (no download needed).
// "impeccable-design" is a small-model adaptation of the official skill
// pbakaus/impeccable skill/SKILL.src.md (Apache-2.0, https://github.com/pbakaus/impeccable).
// The full launcher workflow (impeccable context binary, craft-floor,
// reference playbooks) lives upstream; this built-in keeps the rules a local
// model can actually apply with read/edit/run_command/task: pick a visitor
// mode, honor the brief, verify in bounded passes, then stop polishing.

export const BUILTIN_SKILLS: Record<string, string> = {
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
