// project-task-setup.js - Server side of the "Task Launcher setup wizard"
// (Project Settings → Task Launchers). Three responsibilities:
//   1. list available gh accounts (task_setup_accounts)
//   2. discover a repo's Projects-v2 board statuses via gh GraphQL
//      (task_setup_discover)
//   3. scaffold the full setup from the collected wizard config: recipe JSON +
//      prompt .md (+ optional manual variant), a merged config.json (autoLaunch +
//      launchApi token + dashboard serve command), a TRIAGE.local.md starter, and
//      a paste-to-AI "build the outstanding-issues website" prompt
//      (task_setup_scaffold)
//
// Follows the attachXxx(ctx) pattern (MODULE_MAP.md). Server-side CommonJS.
// var only, no arrow functions. String/JSON builders live in
// project-task-setup-templates.js to keep this module under 500 lines.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { execFileSync } = require("child_process");
var gitAccounts = require("./git-accounts");
var { resolveGhAccount, ghEnv } = require("./project-task-sources");
var tpl = require("./project-task-setup-templates");

function attachTaskSetup(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug || "";
  var send = ctx.send || null;
  var sendTo = ctx.sendTo || null;
  var serverPort = ctx.serverPort || 2633;
  var serverTls = !!ctx.serverTls;
  var getAutoLaunch = ctx.getAutoLaunch || function () { return null; };

  var tasksDir = path.join(cwd, ".clay", "tasks");
  var localDir = path.join(cwd, "localAIConfig");
  var configPath = path.join(tasksDir, "config.json");

  function reply(ws, payload) {
    if (sendTo) sendTo(ws, payload);
    else if (send) send(payload);
  }

  // Reject any path that would escape the project directory.
  function insideCwd(p) {
    var resolved = path.resolve(p);
    return resolved === cwd || resolved.indexOf(cwd + path.sep) === 0;
  }

  function writeFileAtomic(filePath, contents) {
    if (!insideCwd(filePath)) throw new Error("Refusing to write outside project: " + filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    var tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, filePath);
  }

  function readFullConfig() {
    try {
      var parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
  }

  function dashboardPortFrom(full) {
    var dashboards = Array.isArray(full.dashboards) ? full.dashboards : [];
    for (var i = 0; i < dashboards.length; i++) {
      var cmds = (dashboards[i] && Array.isArray(dashboards[i].commands)) ? dashboards[i].commands : [];
      for (var j = 0; j < cmds.length; j++) {
        var args = (cmds[j] && Array.isArray(cmds[j].args)) ? cmds[j].args : [];
        for (var k = 0; k < args.length; k++) {
          var n = parseInt(args[k], 10);
          if (Number.isFinite(n) && n > 1024) return n;
        }
      }
    }
    return 8765;
  }

  // Read the existing setup back into the same shape the wizard collects, so
  // opening the wizard on a configured project shows the current connection
  // (edit) rather than a blank form (create).
  // List recipe-shaped files (those with a task source), excluding the manual
  // variants so the picker stays focused on the primary launchers.
  function listRecipes() {
    var out = [];
    var files;
    try { files = fs.readdirSync(tasksDir); } catch (e) { return out; }
    for (var i = 0; i < files.length; i++) {
      if (!/\.json$/i.test(files[i]) || files[i] === "config.json") continue;
      var id = files[i].replace(/\.json$/i, "");
      if (/-manual$/.test(id)) continue;
      var recipe = readJson(path.join(tasksDir, files[i]));
      if (!recipe || typeof recipe !== "object" || !recipe.source) continue;
      out.push({ id: recipe.id || id, name: recipe.name || id });
    }
    return out;
  }

  function handleState(ws, msg) {
    var full = readFullConfig();
    var al = full.autoLaunch || {};
    var recipes = listRecipes();
    // Which recipe to load: an explicit request, else the auto-launch recipe,
    // else the first available.
    var requested = msg && msg.recipeId ? String(msg.recipeId).replace(/[^a-zA-Z0-9._-]/g, "") : "";
    var recipeId = requested || al.recipeId || (recipes[0] && recipes[0].id) || "assigned-to-me";
    var recipe = readJson(path.join(tasksDir, recipeId + ".json"));
    var exists = recipes.length > 0;
    var prefill = { recipeId: recipeId };
    if (recipe) {
      var src = recipe.source || {};
      var filter = recipe.filter || {};
      var labels = filter.labels || {};
      var vars = (recipe.prompt && recipe.prompt.variables) || {};
      prefill = {
        recipeId: recipe.id || recipeId,
        recipeName: recipe.name || "",
        repo: src.repo || "",
        ghAccount: src.ghAccount || "",
        issueType: filter.type || "",
        assigned: filter.assigned ? String(filter.assigned) : "me",
        skipStatuses: Array.isArray(filter.skipProjectStatuses) ? filter.skipProjectStatuses : [],
        includeStatuses: Array.isArray(filter.includeProjectStatuses) ? filter.includeProjectStatuses : [],
        excludeLabels: Array.isArray(labels.exclude) ? labels.exclude : [],
        titleExcludePrefixes: Array.isArray(filter.titleExcludePrefixes) ? filter.titleExcludePrefixes : [],
        confidenceThreshold: parseInt(vars.confidence_threshold, 10) || 80,
        createManual: fs.existsSync(path.join(tasksDir, recipeId + "-manual.json")),
      };
    }
    prefill.enabled = !!al.enabled;
    prefill.cron = al.cron || "*/5 * * * *";
    prefill.vendorWeights = (al.vendorWeights && typeof al.vendorWeights === "object") ? al.vendorWeights : { claude: 70, codex: 30 };
    prefill.dashboardPort = dashboardPortFrom(full);
    reply(ws, { type: "task_setup_state", exists: exists, recipes: recipes, config: prefill });
  }

  // ---- gh accounts ----------------------------------------------------------

  function handleAccounts(ws) {
    var accounts = [];
    try { accounts = gitAccounts.listGitHubAccounts() || []; } catch (e) {}
    var resolved = "";
    try { resolved = resolveGhAccount(cwd, null, {}) || ""; } catch (e) {}
    reply(ws, { type: "task_setup_accounts", accounts: accounts, resolved: resolved });
  }

  // ---- repo listing ---------------------------------------------------------

  // List repos the authenticated account can access (owner, collaborator, org
  // member), most recently pushed first, so the wizard can offer autocomplete
  // instead of making the user type owner/name from memory.
  function handleRepos(ws, msg) {
    var account = String((msg && msg.ghAccount) || "").trim();
    if (!account) { try { account = resolveGhAccount(cwd, null, {}) || ""; } catch (e) {} }
    var env = ghEnv(cwd, account);
    var repos = [];
    try {
      var raw = execFileSync("gh", [
        "api",
        "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
        "--jq", ".[].full_name",
      ], {
        cwd: cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
        env: env,
      });
      repos = raw.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
    } catch (e) {
      var emsg = (e && e.stderr) ? String(e.stderr) : (e && e.message) || String(e);
      reply(ws, { type: "task_setup_repos", ok: false, error: emsg.trim().split("\n").slice(0, 2).join(" "), account: account, repos: [] });
      return;
    }
    reply(ws, { type: "task_setup_repos", ok: true, account: account, repos: repos });
  }

  // ---- board discovery ------------------------------------------------------

  var DISCOVER_QUERY =
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){" +
    "projectsV2(first:20){nodes{id title number " +
    "field(name:\"Status\"){... on ProjectV2SingleSelectField{id name options{id name}}}}}}}";

  function ghText(args, env) {
    return execFileSync("gh", args, {
      cwd: cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
      env: env,
    });
  }

  // Repo labels (for the exclude-labels picker). Empty list on any failure.
  function fetchLabels(repo, env) {
    try {
      var raw = ghText(["label", "list", "--repo", repo, "--limit", "200", "--json", "name", "--jq", ".[].name"], env);
      return raw.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
    } catch (e) { return []; }
  }

  // Repo collaborators (for the assignee picker). Requires push access; falls
  // back to an empty list (the UI still offers "me" / "anyone").
  function fetchCollaborators(repo, env) {
    try {
      var raw = ghText(["api", "repos/" + repo + "/collaborators?per_page=100", "--jq", ".[].login"], env);
      return raw.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
    } catch (e) { return []; }
  }

  function discoverBoards(repo, env) {
    var parts = String(repo || "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, error: "Repo must be in owner/name form (e.g. trialview/v2)", boards: [] };
    }
    var out;
    try {
      var raw = execFileSync("gh", [
        "api", "graphql",
        "-f", "query=" + DISCOVER_QUERY,
        "-F", "owner=" + parts[0],
        "-F", "name=" + parts[1],
      ], {
        cwd: cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
        env: env,
      });
      out = JSON.parse(raw);
    } catch (e) {
      var msg = (e && e.stderr) ? String(e.stderr) : (e && e.message) || String(e);
      return { ok: false, error: msg.trim().split("\n").slice(0, 3).join(" "), boards: [] };
    }
    var nodes = out && out.data && out.data.repository && out.data.repository.projectsV2 && out.data.repository.projectsV2.nodes;
    nodes = Array.isArray(nodes) ? nodes : [];
    var boards = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] || {};
      var field = n.field || null;
      var options = (field && Array.isArray(field.options)) ? field.options.map(function (o) {
        return { id: o.id, name: o.name };
      }) : [];
      boards.push({
        id: n.id || "",
        title: n.title || ("Project #" + (n.number || "?")),
        number: n.number || null,
        statusFieldId: field ? (field.id || "") : "",
        options: options,
      });
    }
    return { ok: true, boards: boards };
  }

  function handleDiscover(ws, msg) {
    var repo = String((msg && msg.repo) || "").trim();
    var account = String((msg && msg.ghAccount) || "").trim();
    if (!account) { try { account = resolveGhAccount(cwd, null, {}) || ""; } catch (e) {} }
    var env = ghEnv(cwd, account);
    var res = discoverBoards(repo, env);
    // Best-effort extras for the pickers; never fail discovery on their account.
    var labels = res.ok ? fetchLabels(repo, env) : [];
    var collaborators = res.ok ? fetchCollaborators(repo, env) : [];
    reply(ws, {
      type: "task_setup_boards",
      ok: res.ok,
      error: res.error || null,
      repo: repo,
      account: account,
      boards: res.boards,
      labels: labels,
      collaborators: collaborators,
    });
  }

  // ---- scaffold -------------------------------------------------------------

  function safeRecipeId(id) {
    var safe = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "");
    return safe || "assigned-to-me";
  }

  function normalizeCfg(msg) {
    var d = (msg && msg.config) || {};
    var board = d.board && typeof d.board === "object" ? d.board : {};
    return {
      repo: String(d.repo || "").trim(),
      ghAccount: String(d.ghAccount || "").trim(),
      recipeId: safeRecipeId(d.recipeId || "assigned-to-me"),
      recipeName: d.recipeName ? String(d.recipeName) : "",
      board: {
        id: board.id || "",
        title: board.title || "",
        number: board.number || null,
        statusFieldId: board.statusFieldId || "",
        options: Array.isArray(board.options) ? board.options : [],
      },
      skipStatuses: Array.isArray(d.skipStatuses) ? d.skipStatuses : [],
      includeStatuses: Array.isArray(d.includeStatuses) ? d.includeStatuses : [],
      issueType: d.issueType === "bug" || d.issueType === "feature" || d.issueType === "legacy" ? d.issueType : "",
      // "me", "any", or a specific collaborator login.
      assigned: d.assigned ? String(d.assigned).replace(/[^a-zA-Z0-9_-]/g, "") || "me" : "me",
      excludeLabels: Array.isArray(d.excludeLabels) ? d.excludeLabels : [],
      titleExcludePrefixes: Array.isArray(d.titleExcludePrefixes) ? d.titleExcludePrefixes : [],
      vendorWeights: (d.vendorWeights && typeof d.vendorWeights === "object") ? d.vendorWeights : { claude: 70, codex: 30 },
      cron: (typeof d.cron === "string" && d.cron.trim().split(/\s+/).length === 5) ? d.cron.trim() : "*/5 * * * *",
      enabled: !!d.enabled,
      confidenceThreshold: parseInt(d.confidenceThreshold, 10) || 80,
      fetchLimit: parseInt(d.fetchLimit, 10) || 100,
      defaultLimit: parseInt(d.defaultLimit, 10) || 10,
      createManual: d.createManual !== false,
      dashboardPort: parseInt(d.dashboardPort, 10) || 8765,
      environment: d.environment ? String(d.environment) : "",
      overwriteTriage: !!d.overwriteTriage,
    };
  }

  function launchUrl() {
    return (serverTls ? "https" : "http") + "://127.0.0.1:" + serverPort + "/p/" + slug + "/api/task-launch";
  }

  function buildMergedConfig(cfg, token) {
    var full = readFullConfig();
    full.autoLaunch = Object.assign({}, full.autoLaunch, {
      enabled: cfg.enabled,
      recipeId: cfg.recipeId,
      cron: cfg.cron,
      vendorWeights: cfg.vendorWeights,
    });
    full.launchApi = Object.assign({}, full.launchApi, {
      token: token,
      url: launchUrl(),
    });
    // Replace only the wizard-managed "triage" dashboard; keep any others.
    var serveCmd = {
      name: "serve",
      command: "python3",
      args: ["-m", "http.server", String(cfg.dashboardPort), "--directory", "localAIConfig"],
      cwd: ".",
      onServerStart: true,
      detached: true,
    };
    var dashboards = Array.isArray(full.dashboards) ? full.dashboards.filter(function (d) {
      return d && d.name !== "triage";
    }) : [];
    dashboards.push({ name: "triage", commands: [serveCmd] });
    full.dashboards = dashboards;
    return full;
  }

  function writeIfAbsent(filePath, contents, rel, written) {
    if (fs.existsSync(filePath)) return false;
    writeFileAtomic(filePath, contents);
    written.push(rel);
    return true;
  }

  // Shared writer for both full scaffold (new project) and settings-only update
  // (editing a configured project). settingsOnly skips TRIAGE.local.md and the
  // website prompt, and never returns the post-setup "next steps". Prompt .md
  // files are only written when absent so user edits survive an update.
  function doScaffold(ws, msg, opts) {
    opts = opts || {};
    var settingsOnly = !!opts.settingsOnly;
    var cfg = normalizeCfg(msg);
    if (!cfg.repo || cfg.repo.split("/").length !== 2) {
      reply(ws, { type: "task_setup_result", ok: false, error: "A repo in owner/name form is required.", settingsOnly: settingsOnly });
      return;
    }
    var written = [];
    var warnings = [];
    try {
      // 1. Auto recipe (always) + prompt template (only if absent)
      writeFileAtomic(path.join(tasksDir, cfg.recipeId + ".json"), JSON.stringify(tpl.buildAutoRecipe(cfg), null, 2) + "\n");
      written.push(".clay/tasks/" + cfg.recipeId + ".json");
      writeIfAbsent(path.join(tasksDir, cfg.recipeId + ".md"), tpl.buildAutoPromptMd(cfg), ".clay/tasks/" + cfg.recipeId + ".md", written);

      // 2. Optional manual recipe (always) + prompt template (only if absent)
      if (cfg.createManual) {
        writeFileAtomic(path.join(tasksDir, cfg.recipeId + "-manual.json"), JSON.stringify(tpl.buildManualRecipe(cfg), null, 2) + "\n");
        written.push(".clay/tasks/" + cfg.recipeId + "-manual.json");
        writeIfAbsent(path.join(tasksDir, cfg.recipeId + "-manual.md"), tpl.buildManualPromptMd(cfg), ".clay/tasks/" + cfg.recipeId + "-manual.md", written);
      }

      // 3. Merged config.json (preserve unrelated keys; reuse existing token)
      var existing = readFullConfig();
      var token = (existing.launchApi && existing.launchApi.token) ? String(existing.launchApi.token) : crypto.randomBytes(32).toString("hex");
      writeFileAtomic(configPath, JSON.stringify(buildMergedConfig(cfg, token), null, 2) + "\n");
      written.push(".clay/tasks/config.json");

      var websitePrompt = "";
      var manualSteps = [];
      if (!settingsOnly) {
        // 4. TRIAGE.local.md starter (never silently overwrite)
        var triagePath = path.join(localDir, "TRIAGE.local.md");
        if (!fs.existsSync(triagePath) || cfg.overwriteTriage) {
          writeFileAtomic(triagePath, tpl.buildTriageStarter(cfg));
          written.push("localAIConfig/TRIAGE.local.md");
        } else {
          warnings.push("localAIConfig/TRIAGE.local.md already exists — kept as is (enable overwrite to replace).");
        }
        // 5. Website-builder prompt
        websitePrompt = tpl.buildWebsitePrompt(cfg, launchUrl(), token);
        writeFileAtomic(path.join(localDir, "BUILD_DASHBOARD_PROMPT.md"), websitePrompt);
        written.push("localAIConfig/BUILD_DASHBOARD_PROMPT.md");
        manualSteps = [
          "Start (or restart) this project so the dashboard server on port " + cfg.dashboardPort + " comes up — or run the 'triage' dashboard from Project Settings → Dashboards.",
          "Open localAIConfig/BUILD_DASHBOARD_PROMPT.md and paste it to an AI to generate localAIConfig/outstanding-issues.html.",
          "Visit http://localhost:" + cfg.dashboardPort + "/outstanding-issues.html.",
        ];
      }

      // Reconcile the auto-launch schedule live (reads the config we just wrote).
      var al = getAutoLaunch();
      if (al && typeof al.ensureSchedule === "function") { try { al.ensureSchedule(); } catch (e) {} }

      reply(ws, {
        type: "task_setup_result",
        ok: true,
        settingsOnly: settingsOnly,
        filesWritten: written,
        token: token,
        launchUrl: launchUrl(),
        websitePrompt: websitePrompt,
        manualSteps: manualSteps,
        warnings: warnings,
      });
    } catch (e) {
      reply(ws, { type: "task_setup_result", ok: false, settingsOnly: settingsOnly, error: (e && e.message) || String(e), filesWritten: written });
    }
  }

  function handleMessage(ws, msg) {
    if (!msg || !msg.type) return false;
    if (msg.type === "task_setup_state") { handleState(ws, msg); return true; }
    if (msg.type === "task_setup_accounts") { handleAccounts(ws); return true; }
    if (msg.type === "task_setup_repos") { handleRepos(ws, msg); return true; }
    if (msg.type === "task_setup_discover") { handleDiscover(ws, msg); return true; }
    if (msg.type === "task_setup_scaffold") { doScaffold(ws, msg, { settingsOnly: false }); return true; }
    if (msg.type === "task_setup_update") { doScaffold(ws, msg, { settingsOnly: true }); return true; }
    return false;
  }

  return {
    handleMessage: handleMessage,
  };
}

module.exports = { attachTaskSetup: attachTaskSetup };
