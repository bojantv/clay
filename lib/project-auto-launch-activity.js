// project-auto-launch-activity.js - Recent activity log for the auto-launch
// schedule so the sidebar chip can show "what ran today" with a full
// recent-history view for review. Each event records the recipe, item title,
// summary, session id and timestamp.
//
// The client decides what counts as "today" (local midnight) and groups the
// history by day, so this module just keeps a capped, newest-first log.
//
// State lives server-side per project in .clay/tasks/auto-launch-activity.json:
//   { "events": [ { id, type, recipeId, autoKind, number, url, title,
//                   sessionId, storageId, summary, ts }, ... up to 200,
//                   newest first ] }

var fs = require("fs");
var path = require("path");

var MAX_EVENTS = 200;

function createActivityStore(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var file = path.join(tasksDir, "auto-launch-activity.json");
  var seq = 0;

  function readEvents() {
    try {
      var p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (p && Array.isArray(p.events)) return p.events;
    } catch (e) {}
    return [];
  }

  function write(events) {
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      var tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ events: events }, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error("[auto-launch-activity] save failed:", e.message);
    }
  }

  function record(info) {
    info = info || {};
    var events = readEvents();
    var ev = {
      id: "al_" + Date.now() + "_" + (seq++),
      type: info.type === "completed" ? "completed" : "started",
      recipeId: info.recipeId || "",
      autoKind: info.autoKind || "issue",
      number: info.number != null ? info.number : null,
      url: info.url || "",
      title: info.title || "",
      sessionId: info.sessionId != null ? info.sessionId : null,
      // Persistent session reference. localId is a throwaway counter that gets
      // reassigned on every restart, so navigation must resolve by storageId.
      storageId: info.storageId || null,
      summary: info.summary || "",
      ts: Date.now(),
    };
    events.unshift(ev);
    if (events.length > MAX_EVENTS) events = events.slice(0, MAX_EVENTS);
    write(events);
    return ev;
  }

  function payload() {
    return { events: readEvents() };
  }

  function clear() {
    write([]);
  }

  return { record: record, payload: payload, clear: clear };
}

module.exports = { createActivityStore: createActivityStore };
