# Task Launchers

Task launchers let a project define repeatable work starters. Clay owns the generic launcher, while each project owns its own source, filters, prompt, and completion rules.

## Files

Create task launcher files under the project:

```text
.clay/tasks/
  config.json
  github-bug.json
  github-bug.md
  README.md
```

`config.json` is optional. Each other `.json` file is a launcher recipe. A matching Markdown file can be used as the first prompt template.

`config.json` can also expose a token-gated local launch API for project dashboards:

```json
{
  "launchApi": {
    "token": "change-this-local-token",
    "url": "http://127.0.0.1:7292/p/webapp/api/task-launch"
  }
}
```

Dashboards can call that URL with a JSON body containing `token`, `recipe`, `issue`, and `vendor`.
Use `https://` in the URL when the Clay server is running with TLS.

The endpoint is gated by both the Clay auth session and the `launchApi.token`
(constant-time compared). When a request targets a specific `issue`, the
recipe's `filter` (label/assignee/`skipProjectStatuses`) is intentionally **not**
applied — naming an explicit issue is treated as a deliberate request to launch
that exact issue regardless of its project status. The filters only apply when
listing/launching issues in bulk (no `issue` given). Issue bodies are untrusted
input and are interpolated into the launched session's prompt, which inherits
the project's automation mode.

## Commands

```text
/launch
/launch preview github-bug assigned:me type:bug
/launch start github-bug assigned:me type:bug limit:3
/launch start github-bug issue:1782
```

`preview` lists matching work items. `start` creates one Clay session per item and sends the generated prompt immediately.

## Recipe Example

```json
{
  "name": "GitHub bug",
  "source": {
    "provider": "github",
    "kind": "issues",
    "repo": "trialview/v2",
    "fetchLimit": 100
  },
  "filter": {
    "state": "open",
    "assigned": "me",
    "type": "bug",
    "skipProjectStatuses": ["🔄 In progress"],
    "titleExcludePrefixes": ["BE:"],
    "labels": {
      "exclude": ["backend", "legacy"]
    }
  },
  "session": {
    "vendor": "default",
    "model": "default",
    "title": "#{number} {title}"
  },
  "prompt": {
    "template": "github-bug.md",
    "includeFiles": ["localAIConfig/TRIAGE.local.md"],
    "variables": {
      "environment": "dev.trialviewlive.com (master)"
    }
  },
  "completion": {
    "marker": "WORKFLOW_COMPLETE: issue_shipped",
    "archiveSession": true,
    "closeOnUserMessages": ["mark as done", "mark it done", "ship it"]
  }
}
```

For `type:bug`, Clay treats issues labeled `feature` or `legacy` as non-bugs by default. Set `"requireBugLabel": true` in `filter` if your repo uses an explicit `bug` label.

## Prompt Template

`github-bug.md` can use these variables:

```md
Repo: {{repo}}
Issue: {{issue_url}}

Title: {{title}}
Labels: {{labels}}
Assignees: {{assignees}}

Environment: {{environment}}

{{body}}
```

Useful variables include:

- `{{repo}}`
- `{{number}}`
- `{{issue_url}}`
- `{{title}}`
- `{{body}}`
- `{{labels}}`
- `{{assignees}}`
- `{{branch_slug}}`

If `prompt.includeFiles` is set, Clay appends those project files after the rendered template. This is the right place for strict workflow rules, board IDs, PR rules, and project-specific instructions.

## Completion

Clay does not depend on provider-specific close behavior. Instead, the prompt tells the agent to end its final successful workflow message with the configured marker:

```text
WORKFLOW_COMPLETE: issue_shipped
```

When Clay sees that marker in a launched task session and `archiveSession` is true, it archives the session after the successful turn completes.

For shipping-style workflows, Clay can also arm completion when the user sends a completion phrase. Configure `completion.closeOnUserMessages` with project-specific phrases, or omit it to use the defaults: `mark as done`, `mark it done`, `mark done`, `ship it`, and exact `done`. If the recipe has a `completion.marker`, Clay still waits for that marker before archiving so the session can finish the configured workflow first. Recipes without a marker fall back to archiving after the next assistant turn.

This is still scoped to task-launched sessions only, and only applies when the recipe has `archiveSession` or `closeSession` enabled.

## Dashboard Startup

Projects can start or regenerate local dashboards when the Clay project context starts:

```json
{
  "dashboards": [
    {
      "name": "triage",
      "commands": [
        {
          "name": "refresh",
          "command": "python3",
          "args": ["localAIConfig/refresh-triage-dashboard.py"],
          "cwd": ".",
          "onServerStart": true
        },
        {
          "name": "serve",
          "command": "python3",
          "args": ["-m", "http.server", "8765", "--directory", "localAIConfig"],
          "cwd": ".",
          "onServerStart": true,
          "detached": true
        }
      ]
    }
  ]
}
```

Commands run from the project directory unless `cwd` is provided. `cwd` must stay inside the project.
Clay only starts configured commands; project-specific refresh logic, API calls, filters, and dashboard generation stay in the project-owned command.

In multi-user mode, dashboard startup commands run only when the daemon config has `"dashboardAutoStart": true`. Single-user mode keeps dashboard startup enabled by default.

The older single-command form is still supported:

```json
{
  "dashboards": [
    {
      "name": "triage",
      "command": "python3",
      "args": ["-m", "http.server", "8765", "--directory", "localAIConfig"],
      "cwd": ".",
      "onServerStart": true,
      "detached": true
    }
  ]
}
```

## Auto-launch (scheduled, hands-off)

Clay can poll a recipe on a schedule and automatically start a session for each
new matching item — no manual `/launch` click needed. This is driven by
`project-auto-launch.js` and configured in `.clay/tasks/config.json`:

```json
{
  "autoLaunch": {
    "enabled": true,
    "recipeId": "assigned-to-me",
    "cron": "*/5 * * * *",
    "vendorWeights": { "claude": 60, "codex": 40 }
  }
}
```

- `enabled` — master switch (default `false`).
- `recipeId` — the recipe under `.clay/tasks/` to run.
- `cron` — 5-field cron expression (checked every 30s by the loop registry).
- `vendorWeights` — optional. Alternates the coding agent per started session
  using smooth weighted round-robin (a 60/40 Claude/Codex split interleaves as
  claude, codex, claude, codex, claude, …). Omit to use the recipe's
  `session.vendor`. A weight of `0` (or omitting a vendor) runs a single agent.

All of these are editable from the web UI: **Settings → Auto-start assigned
issues** (toggle, recipe picker, cron, and the Claude/Codex split slider).
Changes apply live — no restart needed.

On each tick the recipe is fetched and every matching item that does **not**
already have a session (dedup by `recipeId` + issue number/URL) gets a new
session started automatically. The schedule is stored as an `autolaunch` record
in the loop registry, so it survives restarts.

### Toggle from the UI

The feature can be turned on/off from **User Settings → Behavior →
"Auto-start assigned issues"**. The toggle round-trips over the project
WebSocket (`get_auto_launch` / `set_auto_launch` → `auto_launch_state`); the
server persists `autoLaunch.enabled` to `.clay/tasks/config.json` (merging, so
other keys like `launchApi` are preserved) and **reconciles the schedule live**
— no restart needed. Editing `recipeId`/`cron` is still done in the config file.

### Restricting by project status

Two complementary controls:

- `filter.includeProjectStatuses` — allow-list. The issue must currently be in
  one of these statuses to qualify.
- `filter.skipProjectStatuses` — exclude-list. The issue is dropped if it is in
  any of these statuses.

Status names must match your project's column names **exactly** (case-insensitive,
**including any emoji prefix** — `gh` returns e.g. `📋 Backlog`, `🔧 Dev Complete`).

The bundled `assigned-to-me` recipe targets `trialview/v2`'s Unified Board and
follows that workspace's `TRIAGE.local.md` "outstanding" rule — skip the
done-ish statuses, exclude backend issues:

```json
"filter": {
  "state": "open",
  "assigned": "me",
  "skipProjectStatuses": ["🔧 Dev Complete", "✍️ Ready for production", "✅ Done"],
  "titleExcludePrefixes": ["BE:"],
  "labels": { "exclude": ["BE", "backend"] }
}
```

Because `assigned: "me"` already scopes to you, the triage rule's "In progress
only if it's mine" is satisfied automatically. Label exclusion matches a label
that equals the token, starts with `token-`/`token:`/`token/`/`token `, or (for
tokens ≥4 chars) contains it — so `backend`, `backend-infra`, and `BE-api` are
excluded, while `beta` is not.

### Confidence gate

The bundled `assigned-to-me` recipe pairs auto-launch with a confidence gate in
its prompt template. The agent rates its confidence that it understands the issue
and how to solve it:

- **≥ threshold** (default 80%): it works the issue autonomously and ends with
  the `CLAY_TASK_COMPLETE` marker (the session then auto-closes).
- **< threshold**: it posts what it understood plus its questions, ends with the
  `CLAY_NEEDS_INPUT` marker, and waits for a reply.

Auto-launched sessions suppress the normal per-turn push notification; they only
ping you (in-session notification + mobile push) when the agent emits
`CLAY_NEEDS_INPUT`. Configure the markers via the recipe's `completion` block
(`marker`, `needsInputMarker`).
