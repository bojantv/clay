// Structured, append-only record of stream auto-recovery events.
//
// The daemon already auto-recovers from stalled streams (watchdog) and
// transient connection drops (e.g. "socket connection was closed"). Those
// events are buried in the noisy daemon log, so this module mirrors them to a
// dedicated file (config.recoveryLogPath()) as one JSON object per line. That
// makes the recovery history cheap to tail and query on demand without
// scanning megabytes of daemon output.
//
// Logging must never disrupt the request path, so every operation here is
// best-effort and swallows its own errors.

var fs = require("fs");
var config = require("./config");

// Keep the file bounded so it can't grow without limit on a chatty daemon.
// When it exceeds the cap we keep the most recent half and drop the rest.
var MAX_BYTES = 1024 * 1024;

function trimIfTooLarge(filePath) {
  try {
    var st = fs.statSync(filePath);
    if (st.size <= MAX_BYTES) return;
    var data = fs.readFileSync(filePath, "utf8");
    var lines = data.split("\n");
    var kept = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(filePath, kept.join("\n"));
  } catch (e) {
    // statSync throws when the file doesn't exist yet — nothing to trim.
  }
}

// Append one recovery event. `event` is a plain object; an ISO timestamp is
// added automatically. Example:
//   recordRecoveryEvent({ kind: "watchdog", sessionId: "abc", case: "mid-generation", silentMs: 61000 });
function recordRecoveryEvent(event) {
  try {
    var filePath = config.recoveryLogPath();
    config.ensureConfigDir();
    trimIfTooLarge(filePath);
    var record = Object.assign({ at: new Date().toISOString() }, event || {});
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
  } catch (e) {
    // Never let recovery logging break the stream-handling path.
  }
}

module.exports = {
  recordRecoveryEvent: recordRecoveryEvent,
};
