var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

function maybeStartDashboardCommand(cwd, entry) {
  if (!entry || !entry.command) return;
  var args = Array.isArray(entry.args) ? entry.args : [];
  var entryCwd = entry.cwd ? path.resolve(cwd, entry.cwd) : cwd;
  if (entryCwd !== cwd && entryCwd.indexOf(cwd + path.sep) !== 0) return;
  try {
    var child = childProcess.spawn(entry.command, args, {
      cwd: entryCwd,
      detached: !!entry.detached,
      stdio: "ignore",
    });
    if (entry.detached && child.unref) child.unref();
    console.log("[task-launcher] Started dashboard command: " + entry.command + " " + args.join(" "));
  } catch (e) {
    console.error("[task-launcher] Dashboard command failed:", e.message || e);
  }
}

function startConfiguredDashboards(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var cfg = readJson(path.join(tasksDir, "config.json"));
  var dashboards = cfg && Array.isArray(cfg.dashboards) ? cfg.dashboards : [];
  for (var i = 0; i < dashboards.length; i++) {
    if (dashboards[i].onServerStart) maybeStartDashboardCommand(cwd, dashboards[i]);
  }
  var files;
  try { files = fs.readdirSync(tasksDir); } catch (e) { return; }
  for (var f = 0; f < files.length; f++) {
    if (!/\.json$/i.test(files[f]) || files[f] === "config.json") continue;
    var recipe = readJson(path.join(tasksDir, files[f]));
    var recipeDashboards = recipe && recipe.dashboards ? recipe.dashboards : [];
    for (var d = 0; d < recipeDashboards.length; d++) {
      if (recipeDashboards[d].onServerStart) maybeStartDashboardCommand(cwd, recipeDashboards[d]);
    }
  }
}

module.exports = { startConfiguredDashboards: startConfiguredDashboards };
