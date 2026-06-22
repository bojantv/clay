// project-task-setup-templates.js - Pure string/JSON builders for the task
// launcher setup wizard (project-task-setup.js). Kept separate so the handler
// module stays well under the 500-line limit. No I/O here: every function
// takes a normalized config object and returns a value to be written.
//
// Server-side CommonJS. var only, no arrow functions.

var DONE_MARKER = "CLAY_TASK_COMPLETE";
var NEEDS_INPUT_MARKER = "CLAY_NEEDS_INPUT";

function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

// Build the auto-launch recipe object (.clay/tasks/<id>.json).
function buildAutoRecipe(cfg) {
  var filter = {
    state: "open",
    assigned: cfg.assigned || "me",
  };
  if (cfg.issueType) filter.type = cfg.issueType;
  if (cfg.skipStatuses && cfg.skipStatuses.length) filter.skipProjectStatuses = cfg.skipStatuses.slice();
  if (cfg.includeStatuses && cfg.includeStatuses.length) filter.includeProjectStatuses = cfg.includeStatuses.slice();
  if (cfg.titleExcludePrefixes && cfg.titleExcludePrefixes.length) filter.titleExcludePrefixes = cfg.titleExcludePrefixes.slice();
  if (cfg.excludeLabels && cfg.excludeLabels.length) filter.labels = { exclude: cfg.excludeLabels.slice() };

  var source = {
    provider: "github",
    kind: "issue",
    repo: cfg.repo,
    fetchLimit: cfg.fetchLimit || 100,
  };
  if (cfg.ghAccount) source.ghAccount = cfg.ghAccount;

  return {
    id: cfg.recipeId,
    name: cfg.recipeName || ("Auto-start issues in " + cfg.repo),
    description:
      "Polls " + cfg.repo + " for open issues" +
      (cfg.assigned === "any" ? "" : " assigned to you") +
      ", following TRIAGE.local.md. Works autonomously at ≥" +
      (cfg.confidenceThreshold || 80) + "% confidence, otherwise pauses for input.",
    source: source,
    filter: filter,
    launch: { defaultLimit: cfg.defaultLimit || 10 },
    prompt: {
      template: cfg.recipeId + ".md",
      includeFiles: ["localAIConfig/TRIAGE.local.md"],
      variables: {
        confidence_threshold: String(cfg.confidenceThreshold || 80),
        environment: cfg.environment || "",
      },
    },
    session: {
      title: "#{number} {title}",
      vendor: "default",
      model: "default",
    },
    completion: {
      marker: DONE_MARKER,
      needsInputMarker: NEEDS_INPUT_MARKER,
      closeSession: true,
      archiveSession: true,
    },
  };
}

// Build the auto-launch prompt template (.clay/tasks/<id>.md).
function buildAutoPromptMd(cfg) {
  var threshold = "{{confidence_threshold}}";
  var lines = [];
  lines.push("You have been automatically assigned GitHub issue **#{{number}}** in `{{repo}}`.");
  lines.push("");
  lines.push("## Issue");
  lines.push("**Title:** {{title}}");
  lines.push("**URL:** {{issue_url}}");
  lines.push("**Labels:** {{labels}}");
  lines.push("**Environment:** {{environment}}");
  lines.push("");
  lines.push("{{body}}");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## How to work this issue");
  lines.push("");
  lines.push("This session started automatically. The **TRIAGE.local.md** workflow is included");
  lines.push("below — its **MANDATORY rules are non-negotiable** (especially: never create a PR,");
  lines.push("mark the issue done, or move it on the board until you are explicitly told \"mark it");
  lines.push("done\", \"done\", or \"ship it\").");
  lines.push("");
  lines.push("1. **Understand the issue.** Extract the concrete goal: what would close it?");
  lines.push("   Explore the codebase as needed.");
  lines.push("");
  lines.push("2. **Rate your confidence (0-100%)** that you BOTH understand exactly what is");
  lines.push("   being asked AND know how to implement it correctly without clarification.");
  lines.push("");
  lines.push("3. **Decide based on the " + threshold + "% threshold:**");
  lines.push("");
  lines.push("   - **Confidence below " + threshold + "%:** Do NOT change code. Write a short message");
  lines.push("     with (a) what you understood, (b) your confidence and what is blocking it, and");
  lines.push("     (c) the specific questions you need answered. Then STOP and wait. End that");
  lines.push("     message with this marker on its own line:");
  lines.push("");
  lines.push("     ```");
  lines.push("     " + NEEDS_INPUT_MARKER);
  lines.push("     ```");
  lines.push("");
  lines.push("   - **Confidence at or above " + threshold + "%:** Proceed per the triage workflow:");
  lines.push("     take the \"Starting work\" steps, then implement the fix and write the required");
  lines.push("     test(s). **Do NOT ship.** When ready for review, summarize what you changed and");
  lines.push("     how to verify it, then STOP and wait. End that message with this marker on its");
  lines.push("     own line:");
  lines.push("");
  lines.push("     ```");
  lines.push("     " + NEEDS_INPUT_MARKER);
  lines.push("     ```");
  lines.push("");
  lines.push("4. **After you are told \"ship it\" / \"done\":** complete the triage \"Done\" steps");
  lines.push("   exactly. Only then end your final message with this marker on its own line:");
  lines.push("");
  lines.push("   ```");
  lines.push("   " + DONE_MARKER);
  lines.push("   ```");
  lines.push("");
  lines.push("Emit exactly one marker per turn. Never emit `" + DONE_MARKER + "` until shipping has");
  lines.push("been explicitly confirmed.");
  lines.push("");
  return lines.join("\n");
}

// Build a manual `/launch` recipe object (.clay/tasks/<id>-manual.json).
function buildManualRecipe(cfg) {
  var recipe = buildAutoRecipe(cfg);
  recipe.id = cfg.recipeId + "-manual";
  recipe.name = (cfg.recipeName || ("Issues in " + cfg.repo)) + " (manual)";
  recipe.description = "Manual /launch of issues in " + cfg.repo + ", following TRIAGE.local.md.";
  recipe.launch = { defaultLimit: 3 };
  recipe.prompt.template = cfg.recipeId + "-manual.md";
  recipe.completion = {
    marker: "WORKFLOW_COMPLETE: issue_shipped",
    archiveSession: true,
    closeOnUserMessages: ["mark as done", "mark it done", "ship it"],
  };
  return recipe;
}

// Build the manual prompt template (.clay/tasks/<id>-manual.md).
function buildManualPromptMd(cfg) {
  var lines = [];
  lines.push("Repo: github.com/{{repo}}");
  lines.push("Issue: {{issue_url}}");
  lines.push("");
  lines.push("Title: {{title}}");
  lines.push("Labels: {{labels}}");
  lines.push("Assignees: {{assignees}}");
  lines.push("Environment: {{environment}}");
  lines.push("");
  lines.push("Follow the **TRIAGE.local.md** workflow included below exactly. Do not create a PR,");
  lines.push("mark the issue done, or move it on the board until explicitly told \"ship it\" /");
  lines.push("\"mark it done\". Write a regression test before fixing. Suggested branch:");
  lines.push("`{{branch_slug}}`.");
  lines.push("");
  lines.push("When the full workflow is complete and shipping has been confirmed, end your final");
  lines.push("message with:");
  lines.push("");
  lines.push("```");
  lines.push("WORKFLOW_COMPLETE: issue_shipped");
  lines.push("```");
  lines.push("");
  lines.push("Issue body:");
  lines.push("");
  lines.push("{{body}}");
  lines.push("");
  return lines.join("\n");
}

// Build the TRIAGE.local.md starter, embedding the discovered board IDs.
function buildTriageStarter(cfg) {
  var board = cfg.board || {};
  var options = asArray(board.options);
  var lines = [];
  lines.push("# Triage workflow");
  lines.push("");
  lines.push("> Generated by the Clay task-launcher setup wizard. Edit freely — this file is");
  lines.push("> injected verbatim into every launched session (auto and manual).");
  lines.push("");
  lines.push("## Repository");
  lines.push("");
  lines.push("- Repo: `" + cfg.repo + "`");
  if (cfg.ghAccount) lines.push("- GitHub account for issue work: `" + cfg.ghAccount + "`");
  if (cfg.environment) lines.push("- Environment: " + cfg.environment);
  lines.push("");
  lines.push("## Project board (GitHub Projects v2)");
  lines.push("");
  if (board.title) lines.push("- Board: **" + board.title + "**" + (board.number ? " (#" + board.number + ")" : ""));
  if (board.id) lines.push("- Project node ID: `" + board.id + "`");
  if (board.statusFieldId) lines.push("- Status field ID: `" + board.statusFieldId + "`");
  if (options.length) {
    lines.push("- Status options:");
    for (var i = 0; i < options.length; i++) {
      var opt = options[i] || {};
      lines.push("  - " + (opt.name || "?") + " — `" + (opt.id || "") + "`");
    }
  }
  lines.push("");
  lines.push("Use `gh api graphql` with these IDs to move an issue between columns. Issues may");
  lines.push("have multiple board entries — update every item ID.");
  lines.push("");
  lines.push("## What counts as outstanding");
  lines.push("");
  if (cfg.skipStatuses && cfg.skipStatuses.length) {
    lines.push("Skip issues already in: " + cfg.skipStatuses.map(function (s) { return "`" + s + "`"; }).join(", ") + ".");
  } else {
    lines.push("Define here which board columns are \"done-ish\" and should be skipped.");
  }
  if (cfg.excludeLabels && cfg.excludeLabels.length) {
    lines.push("Exclude issues labelled: " + cfg.excludeLabels.map(function (s) { return "`" + s + "`"; }).join(", ") + ".");
  }
  lines.push("");
  lines.push("## Mandatory rules");
  lines.push("");
  lines.push("- Never create a PR, mark the issue done, or move it to a done-ish column until the");
  lines.push("  user explicitly says \"mark it done\", \"done\", or \"ship it\".");
  lines.push("- Write a regression test that fails before the fix and passes after.");
  lines.push("- Only touch files related to the issue.");
  lines.push("");
  lines.push("## Starting work");
  lines.push("");
  lines.push("1. Assign the issue to yourself" + (cfg.ghAccount ? " (`" + cfg.ghAccount + "`)" : "") + ".");
  lines.push("2. Move the issue to the in-progress column on the board.");
  lines.push("3. Implement + test. Report back for review. Do NOT ship.");
  lines.push("");
  lines.push("## Done (only after explicit confirmation)");
  lines.push("");
  lines.push("1. Branch, commit, push, open a PR (no auto-close keywords).");
  lines.push("2. Comment the PR link on the issue, move it to the done-ish column.");
  lines.push("");
  return lines.join("\n");
}

// Build the "paste this to an AI" prompt that generates the outstanding-issues
// website. Pre-filled with the repo, launch URL, token, and board IDs.
function buildWebsitePrompt(cfg, launchUrl, token, launchRecipeId) {
  var board = cfg.board || {};
  var recipeForLaunch = launchRecipeId || cfg.recipeId;
  var options = asArray(board.options);
  var lines = [];
  lines.push("# Build my \"outstanding issues\" dashboard");
  lines.push("");
  lines.push("Create `localAIConfig/outstanding-issues.html` (plus a generator script if useful)");
  lines.push("for project `" + cfg.repo + "`. Serve it from `localAIConfig/` on port " +
    (cfg.dashboardPort || 8765) + " (Clay's configured dashboard command already does this).");
  lines.push("");
  lines.push("## Data");
  lines.push("");
  lines.push("- Fetch open issues from `" + cfg.repo + "` via the `gh` CLI" +
    (cfg.ghAccount ? " using account `" + cfg.ghAccount + "`" : "") + ", including their");
  lines.push("  GitHub Projects v2 board status.");
  if (cfg.skipStatuses && cfg.skipStatuses.length) {
    lines.push("- Treat these statuses as done/hidden: " +
      cfg.skipStatuses.map(function (s) { return "`" + s + "`"; }).join(", ") + ".");
  }
  if (cfg.excludeLabels && cfg.excludeLabels.length) {
    lines.push("- Exclude issues labelled: " +
      cfg.excludeLabels.map(function (s) { return "`" + s + "`"; }).join(", ") + ".");
  }
  lines.push("");
  lines.push("## Board IDs");
  lines.push("");
  if (board.id) lines.push("- Project node ID: `" + board.id + "`");
  if (board.statusFieldId) lines.push("- Status field ID: `" + board.statusFieldId + "`");
  for (var i = 0; i < options.length; i++) {
    var opt = options[i] || {};
    lines.push("- Status option `" + (opt.name || "?") + "`: `" + (opt.id || "") + "`");
  }
  lines.push("");
  lines.push("## Launch button");
  lines.push("");
  lines.push("Each issue card should have a button that POSTs JSON to Clay's local launch API to");
  lines.push("start a coding session for that issue:");
  lines.push("");
  lines.push("- URL: `" + launchUrl + "`");
  lines.push("- Token: `" + token + "`");
  lines.push("- Body: `{ \"token\": \"<token>\", \"recipe\": \"" + recipeForLaunch + "\", \"issue\": <number>, \"vendor\": \"claude\" }`");
  lines.push("");
  lines.push("Keep the token only in this local file. Do not commit it.");
  lines.push("");
  return lines.join("\n");
}

module.exports = {
  DONE_MARKER: DONE_MARKER,
  NEEDS_INPUT_MARKER: NEEDS_INPUT_MARKER,
  buildAutoRecipe: buildAutoRecipe,
  buildAutoPromptMd: buildAutoPromptMd,
  buildManualRecipe: buildManualRecipe,
  buildManualPromptMd: buildManualPromptMd,
  buildTriageStarter: buildTriageStarter,
  buildWebsitePrompt: buildWebsitePrompt,
};
