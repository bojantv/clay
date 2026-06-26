var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { clampTitle } = require("./text-title");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
var { fetchItems } = require("./project-task-sources");
var {
  automationForClaudePermission,
  automationForCodexConfig,
} = require("./automation-modes");

function attachTaskLauncher(ctx) {
  var cwd = ctx.cwd;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendTo = ctx.sendTo;
  var usersModule = ctx.usersModule;
  var getSessionForWs = ctx.getSessionForWs;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var onProcessingChanged = ctx.onProcessingChanged;
  // Called when an auto-launched session pauses for input (confidence gate).
  // Implemented by project-auto-launch.js, which owns notification delivery.
  var onNeedsInput = ctx.onNeedsInput || null;
  // Called when an auto-launched session finishes its workflow (marker emitted).
  // Implemented by project-auto-launch.js (completion notification + PR state).
  var onComplete = ctx.onComplete || null;
  var tasksDir = path.join(cwd, ".clay", "tasks");

  function readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      return null;
    }
  }

  function readTextIfExists(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (e) {
      return "";
    }
  }

  function taskIdFromFile(file) {
    return path.basename(file).replace(/\.json$/i, "");
  }

  function listRecipes() {
    var recipes = [];
    var files;
    try { files = fs.readdirSync(tasksDir); } catch (e) { return recipes; }
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!/\.json$/i.test(file)) continue;
      if (file === "config.json") continue;
      var id = taskIdFromFile(file);
      var recipe = readJson(path.join(tasksDir, file));
      if (!recipe) continue;
      recipe.id = recipe.id || id;
      recipes.push(recipe);
    }
    return recipes;
  }

  function loadRecipe(id) {
    if (!id) return null;
    var safeId = String(id).replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeId) return null;
    var recipe = readJson(path.join(tasksDir, safeId + ".json"));
    if (!recipe) return null;
    recipe.id = recipe.id || safeId;
    return recipe;
  }

  function isPrReviewKind(recipe) {
    var kind = (recipe && recipe.source && recipe.source.kind) || "";
    return kind === "pr-reviews" || kind === "pr-review" || kind === "prs";
  }

  // Dedup: find a session already launched for this recipe + item. liveOnly
  // skips completed sessions (PR-review recipes relaunch across passes); issue
  // recipes dedup forever so the same issue is never started twice. Single
  // source of truth — the manual launch paths and auto-launch both call this.
  function findExistingSessionForItem(recipe, item, liveOnly) {
    var num = item && item.number != null ? item.number : null;
    var url = (item && item.url) || "";
    var found = null;
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    sm.sessions.forEach(function (s) {
      if (found || !s || !s.taskLauncher) return;
      if (s.taskLauncher.recipeId !== recipe.id) return;
      if (liveOnly && s.taskLauncher.workflowCompleted) return;
      if (num != null && s.taskLauncher.itemNumber === num) { found = s; return; }
      if (url && s.taskLauncher.itemUrl === url) { found = s; return; }
    });
    return found;
  }

  function commandResult(ws, text) {
    sendTo(ws, { type: "slash_command_result", text: text });
  }

  function parseCommand(text) {
    var raw = (text || "").trim();
    var parts = raw.split(/\s+/).filter(function (p) { return !!p; });
    if (parts[0] === "/launch") parts.shift();
    var mode = "preview";
    if (parts[0] === "start" || parts[0] === "preview") {
      mode = parts.shift();
    }
    var recipeId = parts.shift() || "";
    var args = {};
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === "--start") {
        mode = "start";
        continue;
      }
      var idx = part.indexOf(":");
      if (idx === -1) {
        args[part] = true;
      } else {
        args[part.substring(0, idx)] = part.substring(idx + 1);
      }
    }
    return { mode: mode, recipeId: recipeId, args: args };
  }

  function splitList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return String(value).split(",").map(function (v) { return v.trim(); }).filter(function (v) { return !!v; });
  }

  function normalizeTriggerText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function completionTriggerPhrases(completion) {
    var configured = splitList(completion.closeOnUserMessages || completion.triggerPhrases || completion.userTriggers);
    if (configured.length > 0) return configured;
    return [
      "mark as done",
      "mark it done",
      "mark done",
      "ship it",
      "done"
    ];
  }

  function matchesCompletionTrigger(completion, text) {
    var normalized = normalizeTriggerText(text);
    if (!normalized) return false;
    var phrases = completionTriggerPhrases(completion || {});
    for (var i = 0; i < phrases.length; i++) {
      var phrase = normalizeTriggerText(phrases[i]);
      if (!phrase) continue;
      if (phrase === "done") {
        if (normalized === "done" || normalized === "ok done" || normalized === "please done") return true;
        continue;
      }
      if (normalized.indexOf(phrase) !== -1) return true;
    }
    return false;
  }

  // Built when the user manually asks to close a marker-gated task ("mark as
  // done"). Appended to the message the agent receives (not the visible text)
  // so the request drives the agent to actually finish and emit the completion
  // marker, rather than us force-closing mid-task. Returns "" when there is no
  // marker to gate on (nothing to instruct the agent about).
  function completionDirective(completion) {
    var marker = (completion && completion.marker) || "";
    if (!marker) return "";
    var needs = (completion && completion.needsInputMarker) || "";
    var lines = [];
    lines.push("[Clay] The user asked to mark this task as done.");
    lines.push("Now — and only now that the user has explicitly asked — run this project's full \"mark as done\"/Done workflow before finishing: finalize the PR (take it out of draft), comment on and update the issue, move it forward on the board, hand it off to the reviewer, and clean up local artifacts, exactly as your project's conventions (AGENTS/TRIAGE docs) describe.");
    lines.push("Only finish once that workflow is genuinely complete. When it is, end your final message with the exact marker:");
    lines.push("");
    lines.push(marker);
    lines.push("");
    if (needs) {
      lines.push("If you still need a decision or information from the user, end your message with " + needs + " instead. Do not emit the completion marker until the work is actually done.");
    } else {
      lines.push("Do not emit the completion marker until the work is actually done.");
    }
    return lines.join("\n");
  }

  function renderValue(value) {
    if (Array.isArray(value)) return value.join(", ");
    if (value == null) return "";
    return String(value);
  }

  function itemContext(recipe, item) {
    var source = recipe.source || {};
    var labels = item.labels || [];
    var assignees = item.assignees || [];
    var labelList = labels.map(function (l) { return l.name || String(l); });
    var assigneeList = assignees.map(function (a) { return a.login || a.name || String(a); });
    var repo = source.repo || "";
    var issueNumber = item.number != null ? String(item.number) : "";
    var titleSlug = (item.title || "task")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 60);
    return {
      repo: repo,
      number: issueNumber,
      issue_number: issueNumber,
      pr_number: issueNumber,
      title: item.title || "",
      issue_url: item.url || "",
      pr_url: item.url || "",
      url: item.url || "",
      body: item.body || "",
      labels: labelList.join(", "),
      assignees: assigneeList.join(", "),
      branch_slug: issueNumber ? "fix/" + issueNumber + "-" + titleSlug : titleSlug,
      review_findings: item.review_findings || "", // PR-review extras (empty for issues)
      ci_failures: item.ci_failures || "",
      head_sha: item.head_sha || "",
      pass_number: item.pass_number != null ? String(item.pass_number) : "",
      max_passes: item.max_passes != null ? String(item.max_passes) : "",
    };
  }

  function applyTemplate(text, vars) {
    return String(text || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, function (_, key) {
      return renderValue(vars[key]);
    });
  }

  function renderPrompt(recipe, item) {
    var promptCfg = recipe.prompt || {};
    var vars = Object.assign({}, promptCfg.variables || {}, itemContext(recipe, item));
    var templateText = "";
    if (promptCfg.template) {
      templateText = readTextIfExists(path.join(tasksDir, promptCfg.template));
    }
    if (!templateText) {
      templateText = "Repo: {{repo}}\nIssue: {{issue_url}}\n\n{{body}}\n";
    }
    var includeFiles = promptCfg.includeFiles || [];
    var included = [];
    for (var i = 0; i < includeFiles.length; i++) {
      var includePath = path.resolve(cwd, includeFiles[i]);
      if (includePath.indexOf(cwd + path.sep) !== 0 && includePath !== cwd) continue;
      var includeText = readTextIfExists(includePath);
      if (includeText) included.push(includeText);
    }
    var prompt = applyTemplate(templateText, vars);
    if (included.length > 0) {
      prompt += "\n\n---\n\nPROJECT WORKFLOW INSTRUCTIONS:\n\n" + included.join("\n\n---\n\n");
    }
    var completion = recipe.completion || {};
    if (completion.marker) {
      prompt += "\n\n---\n\nWhen the configured workflow is fully complete, end your final message with:\n\n" + completion.marker;
    }
    return prompt;
  }

  function renderTitle(recipe, item) {
    var pattern = (recipe.session && recipe.session.title) || "#{number} {title}";
    var vars = itemContext(recipe, item);
    var title = pattern
      .replace(/\{([a-zA-Z0-9_.-]+)\}/g, function (_, key) { return renderValue(vars[key]); })
      .replace(/#\{number\}/g, "#" + vars.number);
    // The recipe owns the title format (e.g. "#{number} {title}"), so only
    // clean + clamp it. Do NOT run it through meaningfulTextTitle, which is for
    // deriving titles from free-form text and strips a leading "#<n>" issue ref.
    return clampTitle(title, 80) || ("#" + vars.number + " " + vars.title).substring(0, 80);
  }

  function normalizeVendor(vendor) {
    if (vendor === "copilot") return "github-copilot";
    if (vendor === "github") return "github-copilot";
    if (vendor === "chatgpt") return "codex";
    return vendor;
  }

  function defaultSessionOpts(recipe, ws, args, user) {
    var sessionCfg = recipe.session || {};
    var vendor = normalizeVendor((args && args.vendor) || sessionCfg.vendor || sm.defaultVendor || "claude");
    if (vendor === "default") vendor = sm.defaultVendor || "claude";
    var opts = {};
    var owner = (ws && ws._clayUser) || user || null;
    if (owner && usersModule.isMultiUser()) opts.ownerId = owner.id;
    opts.vendor = vendor;
    if (sessionCfg.providerRouteId) opts.providerRouteId = sessionCfg.providerRouteId;
    var model = (args && args.model) || sessionCfg.model || "default";
    if (model === "default") {
      if (sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[vendor]) {
        model = sm.serverDefaultModelsByVendor[vendor];
      } else if (sm.defaultModelsByVendor && sm.defaultModelsByVendor[vendor]) {
        model = sm.defaultModelsByVendor[vendor];
      } else {
        model = null;
      }
    }
    if (model) opts.model = model;
    if (vendor === "codex" || vendor === "github-copilot") {
      var codexDefaults = Object.assign({}, sm.serverDefaultCodexConfig || getCodexConfig(sm, null));
      opts.codexApproval = codexDefaults.approval || CODEX_DEFAULTS.approval;
      opts.codexSandbox = codexDefaults.sandbox || CODEX_DEFAULTS.sandbox;
      opts.codexWebSearch = codexDefaults.webSearch || CODEX_DEFAULTS.webSearch;
      opts.automationMode = automationForCodexConfig(opts.codexApproval, opts.codexSandbox);
      opts.permissionMode = opts.automationMode === "full" ? "bypassPermissions" : "default";
    } else {
      opts.permissionMode = sm.serverDefaultMode || sm._savedDefaultMode || sm.currentPermissionMode || "default";
      opts.automationMode = automationForClaudePermission(opts.permissionMode);
      opts.dangerouslySkipPermissions = opts.permissionMode === "bypassPermissions";
    }
    opts.mode = "gui";
    return opts;
  }

  function startSessionForItem(ws, recipe, item, args, user, launchOpts) {
    launchOpts = launchOpts || {};
    var prompt = renderPrompt(recipe, item);
    var sessionOpts = defaultSessionOpts(recipe, ws, args, user);
    if (!sessionOpts.storageId) sessionOpts.storageId = crypto.randomUUID();
    var session = sm.createSessionRaw(sessionOpts);
    session.title = renderTitle(recipe, item);
    session.titleManuallySet = true;
    var sourceKind = (recipe.source && recipe.source.kind) || "issue";
    var isPrReview = sourceKind === "pr-reviews" || sourceKind === "pr-review" || sourceKind === "prs";
    session.taskLauncher = {
      recipeId: recipe.id,
      itemUrl: item.url || "",
      itemNumber: item.number || null,
      completion: recipe.completion || null,
      autoLaunch: !!launchOpts.auto,
      // Used by the sidebar badge + completion notification to distinguish flavors.
      autoKind: isPrReview ? "pr-review" : "issue",
      prKey: isPrReview ? (item.key || null) : null,
    };
    // Auto-launched sessions should not push on every turn — they only ping
    // when the agent explicitly signals it needs input (see handleTaskTurnDone).
    if (launchOpts.auto) session.suppressDonePush = true;
    var userMsg = { type: "user_message", text: prompt, _ts: Date.now() };
    var owner = (ws && ws._clayUser) || user || null;
    if (owner) {
      userMsg.from = owner.id;
      userMsg.fromName = owner.displayName || owner.username || "";
    }
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);
    session.isProcessing = true;
    session._queryStartTs = Date.now();
    onProcessingChanged();
    sm.saveSessionFile(session);
    sdk.startQuery(session, prompt, null, ensureProjectAccessForSession(session));
    return session;
  }

  function taskLaunchResult(session) {
    return {
      ok: true,
      sessionId: session.storageId || session.cliSessionId || String(session.localId),
      localSessionId: session.localId,
      claySessionId: session.localId,
      cliSessionId: session.cliSessionId || null,
      storageId: session.storageId || null,
      title: session.title,
    };
  }

  function previewText(recipe, items) {
    var lines = [];
    lines.push("Task launcher: " + (recipe.name || recipe.id));
    lines.push("");
    if (items.length === 0) {
      lines.push("No matching items found.");
      return lines.join("\n");
    }
    lines.push(String(items.length) + " matching item" + (items.length === 1 ? "" : "s") + ":");
    for (var i = 0; i < items.length; i++) {
      lines.push("- #" + items[i].number + " " + items[i].title);
    }
    lines.push("");
    lines.push("Start them with:");
    lines.push("/launch start " + recipe.id);
    return lines.join("\n");
  }

  function handleLaunchMessage(ws, msg) {
    if (msg.type !== "task_launch") return false;
    var parsed = parseCommand(msg.command || "");
    if (!parsed.recipeId) {
      var recipes = listRecipes();
      if (recipes.length === 0) {
        commandResult(ws, "No task launchers found. Add recipes under .clay/tasks/*.json.");
        return true;
      }
      var out = ["Available task launchers:"];
      for (var i = 0; i < recipes.length; i++) {
        out.push("- " + recipes[i].id + (recipes[i].name ? " — " + recipes[i].name : ""));
      }
      out.push("");
      out.push("Examples:");
      out.push("/launch preview " + recipes[0].id + " assigned:me type:bug");
      out.push("/launch start " + recipes[0].id + " assigned:me type:bug limit:3");
      commandResult(ws, out.join("\n"));
      return true;
    }
    var recipe = loadRecipe(parsed.recipeId);
    if (!recipe) {
      commandResult(ws, "Task launcher not found: " + parsed.recipeId);
      return true;
    }
    try {
      var items = fetchItems(cwd, recipe, parsed.args);
      var requestedLimit = parsed.args.limit || (recipe.launch && recipe.launch.defaultLimit) || "";
      if (requestedLimit && requestedLimit !== "all") {
        var limit = parseInt(requestedLimit, 10);
        if (Number.isFinite(limit) && limit >= 0) items = items.slice(0, limit);
      }
      if (parsed.mode !== "start") {
        commandResult(ws, previewText(recipe, items));
        return true;
      }
      var started = [];
      var skipped = [];
      var liveOnly = isPrReviewKind(recipe);
      for (var si = 0; si < items.length; si++) {
        // Skip items that already have a session in the list (never start the
        // same issue twice). PR-review recipes only skip still-live sessions.
        if (findExistingSessionForItem(recipe, items[si], liveOnly)) {
          skipped.push(items[si]);
          continue;
        }
        started.push(startSessionForItem(ws, recipe, items[si], parsed.args, null));
      }
      var resultMsg = "Started " + started.length + " task session" + (started.length === 1 ? "" : "s") + ".";
      if (skipped.length > 0) {
        resultMsg += " Skipped " + skipped.length + " already in your session list.";
      }
      commandResult(ws, resultMsg);
      if (started.length > 0) {
        sm.switchSession(started[0].localId, ws);
      }
      sm.broadcastSessionList();
    } catch (e) {
      commandResult(ws, "Task launcher failed: " + (e.message || String(e)));
    }
    return true;
  }

  function handleTaskTurnDone(session, preview, fullText) {
    if (!session || !session.taskLauncher || session.taskLauncher.workflowCompleted) return;
    var completion = session.taskLauncher.completion || {};
    // Confidence gate: if the agent emitted the "needs input" marker, ping the
    // user (in-session + push) and leave the session open awaiting a reply.
    if (session.taskLauncher.autoLaunch) {
      var needsMarker = completion.needsInputMarker || "";
      var turnText = fullText || preview || "";
      if (needsMarker && turnText.indexOf(needsMarker) !== -1) {
        if (onNeedsInput) onNeedsInput(session, turnText);
        return;
      }
    }
    var marker = completion.marker || "";
    var closeAfterNextTurn = !!session.taskLauncher.closeAfterNextTurn;
    if (!marker && !closeAfterNextTurn) return;
    var text = fullText || preview || "";
    // Gate closing on real workflow completion. When a completion marker is
    // configured, the workflow only counts as done once the agent emits it —
    // even when the user manually asked to close ("mark as done"). A manual
    // request appends a directive (see handleTaskUserMessageDispatched) telling
    // the agent to finish and emit the marker, so it still drives toward a
    // close; it just never closes mid-task before the work is actually done.
    // (When no marker is configured there is nothing to gate on, so a manual
    // closeAfterNextTurn still closes once the turn goes idle.)
    if (marker && text.indexOf(marker) === -1) return;
    // Some recipes must never close on the agent's own initiative — they wait
    // for the user to explicitly "mark as done" (issue work that needs human
    // sign-off after a draft PR). When requireUserTrigger is set, an autonomous
    // completion marker is ignored; only a user-triggered close (the manual
    // "mark as done" path sets closeAfterNextTurn) actually finishes the task.
    if (completion.requireUserTrigger && !closeAfterNextTurn) return;
    session.taskLauncher.workflowCompleted = true;
    session.taskLauncher.closeAfterNextTurn = false;
    sm.saveSessionFile(session);
    // Notify the user a session finished. The agent may append a one-line
    // summary after the marker ("CLAY_PR_REVIEW_COMPLETE: fixed 2, 1 won't-fix").
    if (session.taskLauncher.autoLaunch && onComplete) {
      var sumIdx = marker ? text.indexOf(marker) : -1;
      var summary = sumIdx !== -1 ? text.substring(sumIdx + marker.length).split("\n")[0].replace(/^[\s:>-]+/, "").trim() : "";
      try { onComplete(session, summary); } catch (e) { console.log("[task-launcher] onComplete failed:", e && e.message); }
    }
    if (completion.archiveSession || completion.closeSession) {
      // Close only once the session is actually idle again. If the completing
      // turn kicks off a follow-up turn (e.g. a queued message), keep waiting
      // rather than hiding mid-stream. Bounded so a stuck turn can't pin it open.
      var idleAttempts = 0;
      var closeWhenIdle = function closeWhenIdle() {
        if (!session || session.destroying) return;
        if (session.isProcessing && idleAttempts < 60) {
          idleAttempts++;
          setTimeout(closeWhenIdle, 1000);
          return;
        }
        try {
          if (typeof sm.hideSessionForActiveClients === "function") {
            sm.hideSessionForActiveClients(session.localId);
          } else {
            sm.hideSession(session.localId, null);
          }
        }
        catch (e) { console.log("[task-launcher] hideSession on completion failed:", e && e.message); }
      };
      setTimeout(closeWhenIdle, 1000);
    }
  }

  // Returns a directive string to append to the message the agent receives
  // when the user manually asks to close a task ("mark as done"), or "" when
  // there is nothing to inject. The caller appends it to the agent-facing text
  // only (not the visible/stored message).
  function handleTaskUserMessageDispatched(session, text) {
    if (!session || !session.taskLauncher || session.taskLauncher.workflowCompleted) return "";
    // User replied — clear the "awaiting input" latch so a later pause re-pings.
    if (session.taskLauncher.awaitingInputNotified) {
      session.taskLauncher.awaitingInputNotified = false;
      sm.saveSessionFile(session);
    }
    var completion = session.taskLauncher.completion || {};
    if (!completion.archiveSession && !completion.closeSession) return "";
    if (!matchesCompletionTrigger(completion, text || "")) return "";
    session.taskLauncher.closeAfterNextTurn = true;
    session.taskLauncher.closeTriggerText = text || "";
    sm.saveSessionFile(session);
    return completionDirective(completion);
  }

  function launchExternal(body, user) {
    var recipe = loadRecipe(body && (body.recipe || body.recipeId));
    if (!recipe) return { ok: false, error: "Task launcher not found" };
    var args = {};
    if (body.issue) args.issue = String(body.issue);
    if (body.vendor) args.vendor = String(body.vendor);
    if (body.model) args.model = String(body.model);
    var items = fetchItems(cwd, recipe, args);
    if (items.length === 0) return { ok: false, error: "No matching item found" };
    // Manual (dashboard) launches dedup only against a LIVE session for the item
    // — so clicking again starts a fresh session once the previous one finished
    // (e.g. re-working a bounced issue). Auto-launch keeps its own forever-dedup
    // for issues; this only affects explicit external launches.
    var existing = findExistingSessionForItem(recipe, items[0], true);
    if (existing) return Object.assign({ skipped: true }, taskLaunchResult(existing));
    var session = startSessionForItem(null, recipe, items[0], args, user || null);
    sm.switchSession(session.localId, null);
    sm.broadcastSessionList();
    return taskLaunchResult(session);
  }

  return {
    handleLaunchMessage: handleLaunchMessage,
    handleTaskUserMessageDispatched: handleTaskUserMessageDispatched,
    handleTaskTurnDone: handleTaskTurnDone,
    launchExternal: launchExternal,
    loadRecipe: loadRecipe,
    startSessionForItem: startSessionForItem,
    taskLaunchResult: taskLaunchResult,
    findExistingSessionForItem: findExistingSessionForItem,
  };
}

module.exports = { attachTaskLauncher: attachTaskLauncher };
