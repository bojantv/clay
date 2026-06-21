// project-auto-launch.js - Polls a task-launcher recipe on a schedule and
// auto-starts a Clay session for each newly matching item (e.g. GitHub issues
// assigned to the user). Dedup is handled by the task launcher.
//
// Configuration lives server-side in .clay/tasks/config.json:
//   { "autoLaunch": { "enabled": true, "recipeId": "assigned-to-me", "cron": "*/5 * * * *" } }
//
// The schedule itself is stored as a record in the shared loop registry
// (mode: "autolaunch"), so it survives restarts and reuses the 30s tick timer.
// Follows the attachXxx(ctx) pattern per MODULE_MAP.md.

var fs = require("fs");
var path = require("path");
var { fetchItems } = require("./project-task-sources");

var REGISTRY_ID = "autolaunch_assigned";
var DEFAULT_CRON = "*/5 * * * *";

function attachAutoLaunch(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug || "";
  var sm = ctx.sm;
  var loopRegistry = ctx.loopRegistry;
  var getTaskLauncher = ctx.getTaskLauncher;
  var notificationsModule = ctx.notificationsModule || null;
  var pushModule = ctx.pushModule || null;
  var send = ctx.send || null;     // broadcast to all clients of this project
  var sendTo = ctx.sendTo || null; // reply to one client
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var configPath = path.join(tasksDir, "config.json");

  function readFullConfig() {
    try {
      var parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function readConfig() {
    var full = readFullConfig();
    return full.autoLaunch || null;
  }

  function getState() {
    var cfg = readConfig() || {};
    return {
      enabled: !!cfg.enabled,
      recipeId: cfg.recipeId || "assigned-to-me",
      cron: cfg.cron || DEFAULT_CRON,
    };
  }

  function isValidCron(expr) {
    return typeof expr === "string" && expr.trim().split(/\s+/).length === 5;
  }

  // Persist config (merging, never clobbering other keys like launchApi), then
  // reconcile the schedule so changes apply live without a restart. Only the
  // fields present in `partial` are touched.
  function setConfig(partial) {
    partial = partial || {};
    var full = readFullConfig();
    var cfg = full.autoLaunch || {};
    if (partial.enabled !== undefined) cfg.enabled = !!partial.enabled;
    if (partial.recipeId !== undefined) {
      var safeId = String(partial.recipeId || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (safeId) cfg.recipeId = safeId;
    }
    if (partial.cron !== undefined && isValidCron(partial.cron)) {
      cfg.cron = String(partial.cron).trim();
    }
    if (!cfg.recipeId) cfg.recipeId = "assigned-to-me";
    if (!cfg.cron) cfg.cron = DEFAULT_CRON;
    full.autoLaunch = cfg;
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      var tmp = configPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n");
      fs.renameSync(tmp, configPath);
    } catch (e) {
      console.error("[auto-launch] failed to save config:", e.message);
    }
    ensureSchedule();
    return getState();
  }

  // List recipe ids available under .clay/tasks so the UI can offer a picker.
  function listRecipeIds() {
    var ids = [];
    var files;
    try { files = fs.readdirSync(tasksDir); } catch (e) { return ids; }
    for (var i = 0; i < files.length; i++) {
      if (!/\.json$/i.test(files[i]) || files[i] === "config.json") continue;
      ids.push(files[i].replace(/\.json$/i, ""));
    }
    return ids;
  }

  function statePayload() {
    return Object.assign({ type: "auto_launch_state", recipes: listRecipeIds() }, getState());
  }

  function handleMessage(ws, msg) {
    if (!msg || !msg.type) return false;
    if (msg.type === "get_auto_launch") {
      if (sendTo) sendTo(ws, statePayload());
      return true;
    }
    if (msg.type === "set_auto_launch") {
      var partial = {};
      if (msg.enabled !== undefined) partial.enabled = msg.enabled;
      if (msg.recipeId !== undefined) partial.recipeId = msg.recipeId;
      if (msg.cron !== undefined) partial.cron = msg.cron;
      setConfig(partial);
      if (send) send(statePayload()); else if (sendTo) sendTo(ws, statePayload());
      return true;
    }
    return false;
  }

  // Create / update / disable the schedule record to match config on disk.
  function ensureSchedule() {
    if (!loopRegistry) return;
    var cfg = readConfig();
    var existing = loopRegistry.getById(REGISTRY_ID);
    var enabled = !!(cfg && cfg.enabled && cfg.recipeId);
    if (!enabled) {
      if (existing) loopRegistry.updateRecord(REGISTRY_ID, { enabled: false, nextRunAt: null });
      return;
    }
    var cron = cfg.cron || DEFAULT_CRON;
    if (existing) {
      loopRegistry.updateRecord(REGISTRY_ID, {
        enabled: true,
        cron: cron,
        task: cfg.recipeId,
        mode: "autolaunch",
        name: "Auto-launch: " + cfg.recipeId,
        nextRunAt: loopRegistry.nextRunTime(cron),
      });
    } else {
      loopRegistry.register({
        id: REGISTRY_ID,
        name: "Auto-launch: " + cfg.recipeId,
        cron: cron,
        task: cfg.recipeId,
        mode: "autolaunch",
        enabled: true,
      });
    }
    console.log("[auto-launch] Scheduled recipe '" + cfg.recipeId + "' with cron '" + cron + "'");
  }

  // Dedup: has any session already been started for this recipe + item?
  function findExistingSessionForItem(recipe, item) {
    var num = item.number != null ? item.number : null;
    var url = item.url || "";
    var found = null;
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    sm.sessions.forEach(function (s) {
      if (found || !s || !s.taskLauncher) return;
      if (s.taskLauncher.recipeId !== recipe.id) return;
      if (num != null && s.taskLauncher.itemNumber === num) { found = s; return; }
      if (url && s.taskLauncher.itemUrl === url) { found = s; return; }
    });
    return found;
  }

  // Fetch matching items and start a session for each one that does not already
  // have a session (dedup by recipe + item).
  function launchScheduled(recipeId, extraArgs) {
    var tl = getTaskLauncher && getTaskLauncher();
    if (!tl) return { ok: false, error: "Task launcher unavailable", started: [], skipped: [] };
    var recipe = tl.loadRecipe(recipeId);
    if (!recipe) return { ok: false, error: "Recipe not found: " + recipeId, started: [], skipped: [] };
    var args = Object.assign({}, extraArgs || {});
    var items = fetchItems(cwd, recipe, args);
    // Cap new sessions per tick to avoid a thundering herd on the first poll.
    // Dedup means later ticks pick up the remainder once these finish/are seen.
    var perTick = parseInt((recipe.launch && recipe.launch.defaultLimit) || 5, 10);
    if (!Number.isFinite(perTick) || perTick <= 0) perTick = 5;
    var started = [];
    var skipped = [];
    var deferred = 0;
    for (var i = 0; i < items.length; i++) {
      if (findExistingSessionForItem(recipe, items[i])) {
        skipped.push(items[i]);
        continue;
      }
      if (started.length >= perTick) { deferred++; continue; }
      started.push(tl.startSessionForItem(null, recipe, items[i], args, null, { auto: true }));
    }
    if (started.length > 0 && sm && typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    if (deferred > 0) console.log("[auto-launch] capped at " + perTick + " new session(s) this tick; " + deferred + " deferred to next tick");
    return { ok: true, started: started, skipped: skipped, deferred: deferred };
  }

  // Invoked by the loop registry tick when an autolaunch record fires.
  function runScheduled(record) {
    var recipeId = record && record.task;
    if (!recipeId) return;
    try {
      var res = launchScheduled(recipeId);
      var startedCount = (res && res.started) ? res.started.length : 0;
      var skippedCount = (res && res.skipped) ? res.skipped.length : 0;
      if (startedCount > 0 || skippedCount > 0) {
        console.log("[auto-launch] recipe '" + recipeId + "': started " + startedCount + ", skipped " + skippedCount + " (already running)");
      }
    } catch (e) {
      console.error("[auto-launch] failed for recipe '" + recipeId + "':", e.message || e);
    }
  }

  // Called by the task launcher when an auto-launched session pauses for input
  // (confidence below threshold). Pings the user in-session + via mobile push,
  // latched so a single pause only notifies once.
  function notifyNeedsInput(session, text) {
    if (!session || !session.taskLauncher) return;
    if (session.taskLauncher.awaitingInputNotified) return;
    session.taskLauncher.awaitingInputNotified = true;
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    var preview = String(text || "").replace(/\s+/g, " ").trim();
    if (preview.length > 140) preview = preview.substring(0, 140) + "...";
    var title = (session.title || "Task") + " needs your input";
    if (notificationsModule && typeof notificationsModule.notify === "function") {
      notificationsModule.notify("needs_input", {
        title: title,
        preview: preview,
        slug: slug,
        sessionId: session.localId,
        ownerId: session.ownerId || null,
      });
    }
    if (pushModule && typeof pushModule.sendPush === "function") {
      pushModule.sendPush({
        type: "needs_input",
        slug: slug,
        title: title,
        body: preview || "Needs your input",
        tag: "clay-needs-input",
      });
    }
  }

  return {
    ensureSchedule: ensureSchedule,
    runScheduled: runScheduled,
    launchScheduled: launchScheduled,
    notifyNeedsInput: notifyNeedsInput,
    handleMessage: handleMessage,
    getState: getState,
  };
}

module.exports = { attachAutoLaunch: attachAutoLaunch };
