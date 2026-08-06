# Round 2: Executor, Output, And Skill Opposition Review

Active task: `.trellis/tasks/08-06-fast-context-security-release`

Read `prd.md`, `design.md`, and the first-round executor audit. Work only
through the Trellis channel and return one concise final response with exact
task-document or source citations. Do not run Fast Context, tests, network,
credential/environment inspection, or context-mode tools. Do not edit files,
commit, or create any approval, registration, or whitelist mechanism.

Act as a hostile design reviewer. Identify up to three concrete ways the draft
could still permit outside-root reads, hard-deny bypasses, accidental request
startup, raw/data leakage, incompatible CLI behavior, or an improper automatic
Skill invocation. For every issue, state whether it is a blocker and the exact
minimal design correction or test that closes it. Explicitly verify that the
proposal preserves on-demand use without any project-level approval state.

If no blocker remains in an area, say why the stated contract is sufficient.
Keep the answer under 900 words and do not reproduce sensitive-looking paths,
raw response bodies, maps, or key material.
