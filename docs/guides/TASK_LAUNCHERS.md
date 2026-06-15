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
    "archiveSession": true
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

## Dashboard Startup

Projects can start or regenerate local dashboards when the Clay project context starts:

```json
{
  "dashboards": [
    {
      "name": "triage",
      "command": "python3",
      "args": ["localAIConfig/generate-triage-html.py"],
      "cwd": ".",
      "onServerStart": true
    }
  ]
}
```

Commands run from the project directory unless `cwd` is provided. `cwd` must stay inside the project.
