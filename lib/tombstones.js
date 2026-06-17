// Tombstones — track cliSessionIds the user explicitly deleted so the daemon
// won't auto-re-adopt them from ~/.claude/projects/ on next startup. Stored as
// a JSON file with shape: { ids: ["uuid", ...] }. Set semantics; order doesn't
// matter. The Import-session UI uses isTombstoned() to surface deleted CLI
// sessions as importable (and importCliSession() removes the tombstone).

var fs = require("fs");
var path = require("path");
var config = require("./config");

var TOMBSTONES_PATH = path.join(config.CONFIG_DIR, "tombstones.json");

var cache = null;

function load() {
  if (cache) return cache;
  try {
    var raw = fs.readFileSync(TOMBSTONES_PATH, "utf8");
    var data = JSON.parse(raw);
    cache = new Set(Array.isArray(data.ids) ? data.ids : []);
  } catch (e) {
    cache = new Set();
  }
  return cache;
}

function save() {
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(TOMBSTONES_PATH), { recursive: true });
    // Atomic write: temp file + rename, so a crash mid-write cannot truncate
    // the tombstones file (a corrupted file parses as empty on load, which
    // would silently resurrect every deleted CLI session).
    var tmpPath = TOMBSTONES_PATH + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify({ ids: Array.from(cache) }));
    fs.renameSync(tmpPath, TOMBSTONES_PATH);
  } catch (e) {
    console.log("[tombstones] save failed:", e.message);
  }
}

// Drop tombstones for which keepFn(id) is falsy. Used to bound unbounded
// growth: once the underlying CLI session file no longer exists there is
// nothing left to re-adopt, so the tombstone serves no purpose.
function prune(keepFn) {
  if (typeof keepFn !== "function") return;
  load();
  var changed = false;
  Array.from(cache).forEach(function (id) {
    if (!keepFn(id)) {
      cache.delete(id);
      changed = true;
    }
  });
  if (changed) save();
}

function add(cliSessionId) {
  if (!cliSessionId) return;
  load();
  if (cache.has(cliSessionId)) return;
  cache.add(cliSessionId);
  save();
}

function remove(cliSessionId) {
  if (!cliSessionId) return;
  load();
  if (!cache.has(cliSessionId)) return;
  cache.delete(cliSessionId);
  save();
}

function has(cliSessionId) {
  if (!cliSessionId) return false;
  return load().has(cliSessionId);
}

function list() {
  return Array.from(load());
}

module.exports = { add: add, remove: remove, has: has, list: list, prune: prune };
