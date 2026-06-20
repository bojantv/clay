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

var REGISTRY_ID = "autolaunch_assigned";
var DEFAULT_CRON = "*/5 * * * *";

function attachAutoLaunch(ctx) {
  var cwd = ctx.cwd;
  var loopRegistry = ctx.loopRegistry;
  var getTaskLauncher = ctx.getTaskLauncher;
  var configPath = path.join(cwd, ".clay", "tasks", "config.json");

  function readConfig() {
    try {
      var parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return (parsed && parsed.autoLaunch) || null;
    } catch (e) {
      return null;
    }
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

  // Invoked by the loop registry tick when an autolaunch record fires.
  function runScheduled(record) {
    var tl = getTaskLauncher && getTaskLauncher();
    if (!tl || typeof tl.launchScheduled !== "function") return;
    var recipeId = record && record.task;
    if (!recipeId) return;
    try {
      var res = tl.launchScheduled(recipeId);
      var startedCount = (res && res.started) ? res.started.length : 0;
      var skippedCount = (res && res.skipped) ? res.skipped.length : 0;
      if (startedCount > 0 || skippedCount > 0) {
        console.log("[auto-launch] recipe '" + recipeId + "': started " + startedCount + ", skipped " + skippedCount + " (already running)");
      }
    } catch (e) {
      console.error("[auto-launch] failed for recipe '" + recipeId + "':", e.message || e);
    }
  }

  return {
    ensureSchedule: ensureSchedule,
    runScheduled: runScheduled,
  };
}

module.exports = { attachAutoLaunch: attachAutoLaunch };
