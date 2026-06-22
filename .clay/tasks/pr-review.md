You have been automatically assigned to follow up on **PR #{{number}}** in `{{repo}}` — a pull request you authored or contributed commits to.

## PR
**Title:** {{title}}
**URL:** {{pr_url}}
**Head commit:** {{head_sha}}
**This is pass {{pass_number}} of {{max_passes}}** for this PR.

## Failing CI checks
{{ci_failures}}

## New review feedback
{{review_findings}}

---

## How to work this PR

This session started automatically because the PR has failing CI and/or new review
feedback. You have a strict budget of **{{max_passes}} passes** per PR, so be decisive
and avoid scope creep — address what is in front of you, nothing more.

1. **Get on the branch.** Check out the PR branch with `gh pr checkout {{number}}`
   (or fetch + checkout its head ref). All commits go to this PR's existing branch —
   never to `master`/`main`.

2. **Triage each item on its own merits.** For every failing check and every review
   finding above, decide whether it is genuinely worth addressing. Reviewers (Copilot
   especially) raise plenty of low-value or incorrect points — you are not obligated to
   act on all of them.

   - **Worth addressing:** implement the fix.
   - **Not worth addressing:** reply on the PR explaining *why* (wrong, out of scope,
     intentional, already handled, etc.). Reply to the specific review/comment when you
     can; otherwise post a single consolidated `gh pr comment {{number}}` covering the
     points you are declining. Keep it short and concrete.

3. **Drive CI to green.** Run `gh pr checks {{number}}` to see status. Fix the cause of
   any genuine failure, commit, and push to the PR branch. Keep iterating — re-running
   checks and fixing — until the required checks pass. Do not stop with red CI unless it
   is failing for a reason outside this PR's control (say so explicitly if so).

4. **Commit and push** your changes to the PR branch following the project's commit
   conventions. Group related fixes into clear commits.

5. **Confidence gate.** If at any point you are unsure whether a change is correct, or a
   finding needs the author's judgment, do NOT guess. Write a short message stating what
   you understood, what is blocking you, and the specific question(s), then end with this
   marker on its own line and stop:

   ```
   CLAY_NEEDS_INPUT
   ```

When everything is done — worthwhile findings fixed, declined ones answered, and CI green
(or explained) — end your final message with the marker below, followed by a one-line
summary on the same line. The summary becomes the completion notification, so make it
count:

```
CLAY_PR_REVIEW_COMPLETE: fixed 2 findings, 1 won't-fix, CI green
```

Emit only one of the two markers, and only `CLAY_PR_REVIEW_COMPLETE` once the work is
genuinely finished.
