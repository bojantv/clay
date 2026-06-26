// project-issue-launch-state.js - Per-issue bookkeeping for the auto-launch
// "issue" sources. Issue recipes dedup forever (the same issue is never started
// twice) so the agent does not re-run work that is already in flight. This
// store adds one controlled exception: when an auto-launched session finished
// AND the issue then progressed forward on the board (e.g. moved to "Dev
// Complete"), we "arm" the issue. If it later bounces back into a ready status
// (QA reopened it), the auto-launch loop is allowed to start ONE fresh session.
//
// State lives server-side per project in .clay/tasks/issue-launch-state.json:
//   {
//     "trialview/v2#1881": {
//       "status": "completed",           // launched | completed
//       "statusAtCompletion": "Dev Complete",
//       "armed": true,                   // progressed forward -> a bounce relaunches
//       "lastLaunchAt": 1718966400000,
//       "completedAt": 1718966400000,
//       "updatedAt": 1718966400000
//     }
//   }
//
// Follows CommonJS per MODULE_MAP.md. var-only, no arrow functions.

var fs = require("fs");
var path = require("path");

function createIssueLaunchState(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var statePath = path.join(tasksDir, "issue-launch-state.json");

  function read() {
    try {
      var parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function write(all) {
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      var tmp = statePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
      fs.renameSync(tmp, statePath);
    } catch (e) {
      console.error("[issue-launch-state] failed to save:", e.message);
    }
  }

  function defaultEntry() {
    return {
      status: "launched",
      statusAtCompletion: "",
      armed: false,
      lastLaunchAt: 0,
      completedAt: 0,
      updatedAt: 0,
    };
  }

  function get(key) {
    var all = read();
    return Object.assign(defaultEntry(), all[key] || {});
  }

  // A completed issue is normally deduped forever. We only override that when it
  // bounced: the session finished, the issue progressed off a ready status, and
  // it has since returned to a ready status (it is back in the candidate list).
  function shouldRelaunch(key) {
    if (!key) return false;
    var all = read();
    var entry = all[key];
    return !!(entry && entry.armed === true);
  }

  // Record that we are starting a session for this issue NOW. Disarms any
  // pending bounce so a single bounce only relaunches once.
  function recordLaunch(key) {
    if (!key) return null;
    var all = read();
    var entry = Object.assign(defaultEntry(), all[key] || {});
    entry.status = "launched";
    entry.armed = false;
    entry.lastLaunchAt = Date.now();
    entry.updatedAt = Date.now();
    all[key] = entry;
    write(all);
    return entry;
  }

  // Record that an auto-launched session finished. `progressed` is true when the
  // issue has moved off a ready status (e.g. into "In progress"/"Dev Complete").
  // Only progressed issues are armed: if the work never advanced the board,
  // relaunching on the very next poll would loop forever.
  function recordCompletion(key, statusAtCompletion, progressed) {
    if (!key) return;
    var all = read();
    var entry = Object.assign(defaultEntry(), all[key] || {});
    entry.status = "completed";
    entry.statusAtCompletion = statusAtCompletion ? String(statusAtCompletion) : "";
    entry.armed = !!progressed;
    entry.completedAt = Date.now();
    entry.updatedAt = Date.now();
    all[key] = entry;
    write(all);
  }

  return {
    read: read,
    get: get,
    shouldRelaunch: shouldRelaunch,
    recordLaunch: recordLaunch,
    recordCompletion: recordCompletion,
  };
}

module.exports = { createIssueLaunchState: createIssueLaunchState };
