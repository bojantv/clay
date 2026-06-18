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

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function maybeStartDashboardCommand(cwd, entry, dashboardName) {
  if (!entry || !entry.command) return { ok: false, error: "Missing command" };
  var args = Array.isArray(entry.args) ? entry.args : [];
  var entryCwd = entry.cwd ? path.resolve(cwd, entry.cwd) : cwd;
  if (entryCwd !== cwd && entryCwd.indexOf(cwd + path.sep) !== 0) return { ok: false, error: "Dashboard cwd must stay inside project" };
  try {
    var child = childProcess.spawn(entry.command, args, {
      cwd: entryCwd,
      detached: !!entry.detached,
      stdio: "ignore",
    });
    if (entry.detached && child.unref) child.unref();
    var label = dashboardName ? dashboardName + " " : "";
    if (entry.name) label += entry.name + " ";
    console.log("[task-launcher] Started dashboard " + label + "command: " + entry.command + " (" + args.length + " arg" + (args.length === 1 ? "" : "s") + ")");
    return { ok: true, pid: child.pid || null };
  } catch (e) {
    console.error("[task-launcher] Dashboard command failed:", e.message || e);
    return { ok: false, error: e.message || "Dashboard command failed" };
  }
}

function normalizeDashboardCommands(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.commands)) return entry.commands;
  if (entry.command) return [entry];
  return [];
}

function maybeStartDashboard(cwd, entry) {
  if (!entry) return;
  var commands = normalizeDashboardCommands(entry);
  for (var i = 0; i < commands.length; i++) {
    if (commands[i] && commands[i].onServerStart) {
      maybeStartDashboardCommand(cwd, commands[i], entry.name || "");
    }
  }
}

function configFilePath(cwd) {
  return path.join(cwd, ".clay", "tasks", "config.json");
}

function listDashboardFiles(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var files = [configFilePath(cwd)];
  var taskFiles;
  try { taskFiles = fs.readdirSync(tasksDir); } catch (e) { return files; }
  for (var i = 0; i < taskFiles.length; i++) {
    if (!/\.json$/i.test(taskFiles[i]) || taskFiles[i] === "config.json") continue;
    files.push(path.join(tasksDir, taskFiles[i]));
  }
  return files;
}

function dashboardsFromFile(filePath) {
  var cfg = readJson(filePath);
  var dashboards = cfg && Array.isArray(cfg.dashboards) ? cfg.dashboards : [];
  return { config: cfg, dashboards: dashboards };
}

function commandSummary(command, commandIndex) {
  return {
    index: commandIndex,
    name: command.name || "",
    command: command.command || "",
    args: Array.isArray(command.args) ? command.args : [],
    cwd: command.cwd || ".",
    detached: !!command.detached,
    onServerStart: !!command.onServerStart,
  };
}

function listDashboardConfig(cwd) {
  var out = [];
  var files = listDashboardFiles(cwd);
  for (var f = 0; f < files.length; f++) {
    var parsed = dashboardsFromFile(files[f]);
    for (var d = 0; d < parsed.dashboards.length; d++) {
      var dashboard = parsed.dashboards[d];
      var commands = normalizeDashboardCommands(dashboard);
      var summary = {
        source: path.relative(cwd, files[f]),
        sourceIndex: f,
        dashboardIndex: d,
        name: dashboard.name || ("Dashboard " + (d + 1)),
        commands: [],
      };
      for (var c = 0; c < commands.length; c++) summary.commands.push(commandSummary(commands[c], c));
      out.push(summary);
    }
  }
  return out;
}

function startConfiguredDashboards(cwd) {
  var cfg = readJson(configFilePath(cwd));
  var dashboards = cfg && Array.isArray(cfg.dashboards) ? cfg.dashboards : [];
  for (var i = 0; i < dashboards.length; i++) {
    maybeStartDashboard(cwd, dashboards[i]);
  }
  var files = listDashboardFiles(cwd);
  for (var f = 0; f < files.length; f++) {
    if (files[f] === configFilePath(cwd)) continue;
    var recipe = readJson(files[f]);
    var recipeDashboards = recipe && recipe.dashboards ? recipe.dashboards : [];
    for (var d = 0; d < recipeDashboards.length; d++) {
      maybeStartDashboard(cwd, recipeDashboards[d]);
    }
  }
}

function getCommandTarget(cwd, source, dashboardIndex, commandIndex) {
  var sourcePath = path.resolve(cwd, source || "");
  var tasksDir = path.join(cwd, ".clay", "tasks");
  if (sourcePath !== configFilePath(cwd) && sourcePath.indexOf(tasksDir + path.sep) !== 0) {
    return { ok: false, error: "Invalid dashboard source" };
  }
  var parsed = dashboardsFromFile(sourcePath);
  var dashboard = parsed.dashboards[dashboardIndex];
  if (!dashboard) return { ok: false, error: "Dashboard not found" };
  var commands = normalizeDashboardCommands(dashboard);
  var command = commands[commandIndex];
  if (!command) return { ok: false, error: "Command not found" };
  return {
    ok: true,
    sourcePath: sourcePath,
    config: parsed.config,
    dashboard: dashboard,
    commands: commands,
    command: command,
  };
}

function attachTaskDashboard(ctx) {
  var cwd = ctx.cwd;
  var sendTo = ctx.sendTo;
  var usersModule = ctx.usersModule;
  var osUsers = ctx.osUsers;

  function dashboardDeniedType(type) {
    if (type === "dashboard_command_update") return "dashboard_command_update_result";
    if (type === "dashboard_command_run") return "dashboard_command_result";
    return "dashboard_config";
  }

  function canUseDashboardCommands(ws) {
    if (!usersModule || !usersModule.isMultiUser || !usersModule.isMultiUser()) return true;
    if (!ws || !ws._clayUser) return false;
    var perms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
    return !!(perms && perms.terminal);
  }

  function handleDashboardMessage(ws, msg) {
    if (msg.type === "dashboard_config_list" || msg.type === "dashboard_command_run" || msg.type === "dashboard_command_update") {
      if (!canUseDashboardCommands(ws)) {
        sendTo(ws, { type: dashboardDeniedType(msg.type), ok: false, error: "Dashboard command access is not permitted", dashboards: [] });
        return true;
      }
    }

    if (msg.type === "dashboard_config_list") {
      sendTo(ws, { type: "dashboard_config", dashboards: listDashboardConfig(cwd) });
      return true;
    }

    if (msg.type === "dashboard_command_run") {
      var runTarget = getCommandTarget(cwd, msg.source, Number(msg.dashboardIndex), Number(msg.commandIndex));
      if (!runTarget.ok) {
        sendTo(ws, { type: "dashboard_command_result", ok: false, error: runTarget.error });
        return true;
      }
      var runResult = maybeStartDashboardCommand(cwd, runTarget.command, runTarget.dashboard.name || "");
      sendTo(ws, {
        type: "dashboard_command_result",
        ok: runResult.ok,
        error: runResult.error,
        pid: runResult.pid || null,
        source: msg.source,
        dashboardIndex: Number(msg.dashboardIndex),
        commandIndex: Number(msg.commandIndex),
      });
      return true;
    }

    if (msg.type === "dashboard_command_update") {
      var updateTarget = getCommandTarget(cwd, msg.source, Number(msg.dashboardIndex), Number(msg.commandIndex));
      if (!updateTarget.ok) {
        sendTo(ws, { type: "dashboard_command_update_result", ok: false, error: updateTarget.error });
        return true;
      }
      updateTarget.command.onServerStart = !!msg.onServerStart;
      try {
        writeJson(updateTarget.sourcePath, updateTarget.config);
        sendTo(ws, {
          type: "dashboard_command_update_result",
          ok: true,
          source: msg.source,
          dashboardIndex: Number(msg.dashboardIndex),
          commandIndex: Number(msg.commandIndex),
        });
        sendTo(ws, { type: "dashboard_config", dashboards: listDashboardConfig(cwd) });
      } catch (e) {
        sendTo(ws, { type: "dashboard_command_update_result", ok: false, error: e.message || "Failed to save dashboard config" });
      }
      return true;
    }
    return false;
  }

  return { handleDashboardMessage: handleDashboardMessage };
}

module.exports = {
  attachTaskDashboard: attachTaskDashboard,
  startConfiguredDashboards: startConfiguredDashboards,
};
