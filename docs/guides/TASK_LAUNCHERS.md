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
