// project-auto-launch-activity.js - Recent activity log for the auto-launch
// schedule so the sidebar chip can show "what happened while you weren't
// looking": how many sessions were started and completed per poll, with a
// recent-events list (item title, summary, session id, timestamp) for review.
//
// State lives server-side per project in .clay/tasks/auto-launch-activity.json:
//   {
//     "events": [ { id, type, recipeId, autoKind, number, url, title,
//                   sessionId, summary, ts }, ... up to 50, newest first ],
//     "seenAt": 0   // last time the user acknowledged; badges count events newer than this
//   }

var fs = require("fs");
var path = require("path");

var MAX_EVENTS = 50;

function createActivityStore(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var file = path.join(tasksDir, "auto-launch-activity.json");
  var seq = 0;

  function read() {
    try {
      var p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (p && typeof p === "object") {
        return { events: Array.isArray(p.events) ? p.events : [], seenAt: p.seenAt || 0 };
      }
    } catch (e) {}
    return { events: [], seenAt: 0 };
  }

  function write(data) {
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      var tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error("[auto-launch-activity] save failed:", e.message);
    }
  }

  function record(info) {
    info = info || {};
    var data = read();
    var ev = {
      id: "al_" + Date.now() + "_" + (seq++),
      type: info.type === "completed" ? "completed" : "started",
      recipeId: info.recipeId || "",
      autoKind: info.autoKind || "issue",
      number: info.number != null ? info.number : null,
      url: info.url || "",
      title: info.title || "",
      sessionId: info.sessionId != null ? info.sessionId : null,
      summary: info.summary || "",
      ts: Date.now(),
    };
    data.events.unshift(ev);
    if (data.events.length > MAX_EVENTS) data.events = data.events.slice(0, MAX_EVENTS);
    write(data);
    return ev;
  }

  // Mark everything up to now as seen, so the badge counts reset to zero.
  function ack() {
    var data = read();
    data.seenAt = Date.now();
    write(data);
  }

  function payload() {
    var data = read();
    var started = 0;
    var completed = 0;
    for (var i = 0; i < data.events.length; i++) {
      if (data.events[i].ts <= data.seenAt) continue;
      if (data.events[i].type === "completed") completed++;
      else started++;
    }
    return { events: data.events, seenAt: data.seenAt, counts: { started: started, completed: completed } };
  }

  return { record: record, ack: ack, payload: payload };
}

module.exports = { createActivityStore: createActivityStore };
