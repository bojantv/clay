var fs = require("fs");
var path = require("path");
var { execFileSync } = require("child_process");
var { meaningfulTextTitle } = require("./text-title");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
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

  function labelNames(issue) {
    var labels = issue && issue.labels ? issue.labels : [];
    var names = [];
    for (var i = 0; i < labels.length; i++) {
      names.push(String(labels[i].name || labels[i]).toLowerCase());
    }
    return names;
  }

  function hasLabel(names, label) {
    var wanted = String(label || "").toLowerCase();
    if (!wanted) return false;
    return names.indexOf(wanted) !== -1;
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

  function execGh(args) {
    var out = execFileSync("gh", args, {
      cwd: cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(out);
  }

  function ghLogin() {
    try {
      var user = execGh(["api", "user"]);
      return user && user.login ? user.login : null;
    } catch (e) {
      return null;
    }
  }

  function issueAssignedTo(issue, assignee) {
    if (!assignee || assignee === "any") return true;
    var list = issue.assignees || [];
    for (var i = 0; i < list.length; i++) {
      var login = list[i] && (list[i].login || list[i].name);
      if (login === assignee) return true;
    }
    return false;
  }

  function issueMatches(recipe, args, issue, currentLogin) {
    var filter = recipe.filter || {};
    var names = labelNames(issue);
    var skipStatuses = args.issue ? [] : splitList(args.skipStatus || filter.skipProjectStatuses);
    var projectItems = issue.projectItems || [];
    for (var ps = 0; ps < projectItems.length; ps++) {
      var statusName = projectItems[ps] && projectItems[ps].status && projectItems[ps].status.name;
      for (var ss = 0; ss < skipStatuses.length; ss++) {
        if (statusName && statusName.toLowerCase() === String(skipStatuses[ss]).toLowerCase()) return false;
      }
    }
    var titleExcludePrefixes = splitList(filter.titleExcludePrefixes);
    var issueTitle = String(issue.title || "").toLowerCase();
    for (var tp = 0; tp < titleExcludePrefixes.length; tp++) {
      var prefix = String(titleExcludePrefixes[tp] || "").toLowerCase();
      if (prefix && issueTitle.indexOf(prefix) === 0) return false;
    }
    var assigned = args.assigned || filter.assigned || "";
    if (assigned === "me") assigned = currentLogin || "";
    if (assigned && !issueAssignedTo(issue, assigned)) return false;

    var include = splitList(args.label || args.include || (filter.labels && filter.labels.include));
    for (var i = 0; i < include.length; i++) {
      if (!hasLabel(names, include[i])) return false;
    }

    var exclude = splitList(args.exclude || (filter.labels && filter.labels.exclude));
    for (var ex = 0; ex < exclude.length; ex++) {
      if (hasLabel(names, exclude[ex])) return false;
    }

    var type = args.type || filter.type || "";
    if (type === "bug") {
      if (hasLabel(names, "feature") || hasLabel(names, "legacy")) return false;
      if (filter.requireBugLabel && !hasLabel(names, "bug")) return false;
    }
    if (type === "feature" && !hasLabel(names, "feature")) return false;
    if (type === "legacy" && !hasLabel(names, "legacy")) return false;
    return true;
  }

  function githubIssues(recipe, args) {
    var source = recipe.source || {};
    var repo = args.repo || source.repo;
    if (!repo) throw new Error("Recipe is missing source.repo");
    var currentLogin = ghLogin();
    if (args.issue) {
      var issue = execGh([
        "issue", "view", String(args.issue),
        "--repo", repo,
        "--json", "number,title,url,body,labels,assignees,state,projectItems",
      ]);
      return [issue];
    }
    var state = args.state || (recipe.filter && recipe.filter.state) || "open";
    var limit = parseInt(args.fetch || (recipe.source && recipe.source.fetchLimit) || 100, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    var issues = execGh([
      "issue", "list",
      "--repo", repo,
      "--state", state,
      "--limit", String(limit),
      "--json", "number,title,url,body,labels,assignees,state,projectItems",
    ]);
    var out = [];
    for (var i = 0; i < issues.length; i++) {
      if (issueMatches(recipe, args, issues[i], currentLogin)) out.push(issues[i]);
    }
    return out;
  }

  function fetchItems(recipe, args) {
    var source = recipe.source || {};
    if (source.provider === "github" && (!source.kind || source.kind === "issue" || source.kind === "issues")) {
      return githubIssues(recipe, args);
    }
    throw new Error("Unsupported task source: " + (source.provider || "unknown"));
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
      title: item.title || "",
      issue_url: item.url || "",
      url: item.url || "",
      body: item.body || "",
      labels: labelList.join(", "),
      assignees: assigneeList.join(", "),
      branch_slug: issueNumber ? "fix/" + issueNumber + "-" + titleSlug : titleSlug,
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
    return meaningfulTextTitle(title, 80) || ("#" + vars.number + " " + vars.title).substring(0, 80);
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

  function startSessionForItem(ws, recipe, item, args, user) {
    var prompt = renderPrompt(recipe, item);
    var session = sm.createSessionRaw(defaultSessionOpts(recipe, ws, args, user));
    session.title = renderTitle(recipe, item);
    session.titleManuallySet = true;
    session.taskLauncher = {
      recipeId: recipe.id,
      itemUrl: item.url || "",
      itemNumber: item.number || null,
      completion: recipe.completion || null,
    };
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
      var items = fetchItems(recipe, parsed.args);
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
      for (var si = 0; si < items.length; si++) {
        started.push(startSessionForItem(ws, recipe, items[si], parsed.args, null));
      }
      commandResult(ws, "Started " + started.length + " task session" + (started.length === 1 ? "" : "s") + ".");
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
    var marker = completion.marker || "";
    var closeAfterNextTurn = !!session.taskLauncher.closeAfterNextTurn;
    if (!marker && !closeAfterNextTurn) return;
    var text = fullText || preview || "";
    if (marker && text.indexOf(marker) === -1) return;
    session.taskLauncher.workflowCompleted = true;
    session.taskLauncher.closeAfterNextTurn = false;
    sm.saveSessionFile(session);
    if (completion.archiveSession || completion.closeSession) {
      setTimeout(function () {
        try { sm.hideSession(session.localId, null); }
        catch (e) { console.log("[task-launcher] hideSession on completion failed:", e && e.message); }
      }, 1000);
    }
  }

  function handleTaskUserMessageDispatched(session, text) {
    if (!session || !session.taskLauncher || session.taskLauncher.workflowCompleted) return false;
    var completion = session.taskLauncher.completion || {};
    if (!completion.archiveSession && !completion.closeSession) return false;
    if (!matchesCompletionTrigger(completion, text || "")) return false;
    session.taskLauncher.closeAfterNextTurn = true;
    session.taskLauncher.closeTriggerText = text || "";
    sm.saveSessionFile(session);
    return true;
  }

  function launchExternal(body, user) {
    var recipe = loadRecipe(body && (body.recipe || body.recipeId));
    if (!recipe) return { ok: false, error: "Task launcher not found" };
    var args = {};
    if (body.issue) args.issue = String(body.issue);
    if (body.vendor) args.vendor = String(body.vendor);
    if (body.model) args.model = String(body.model);
    var items = fetchItems(recipe, args);
    if (items.length === 0) return { ok: false, error: "No matching item found" };
    var session = startSessionForItem(null, recipe, items[0], args, user || null);
    sm.switchSession(session.localId, null);
    sm.broadcastSessionList();
    return { ok: true, sessionId: session.localId, title: session.title };
  }

  return {
    handleLaunchMessage: handleLaunchMessage,
    handleTaskUserMessageDispatched: handleTaskUserMessageDispatched,
    handleTaskTurnDone: handleTaskTurnDone,
    launchExternal: launchExternal,
  };
}

module.exports = { attachTaskLauncher: attachTaskLauncher };
