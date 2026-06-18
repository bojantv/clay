var fs = require("fs");
var path = require("path");
var readline = require("readline");
var utils = require("./utils");
var { REAL_HOME } = require("./config");

var encodeCwd = utils.encodeCwd;

/**
 * Parse the first ~20 lines of a CLI session JSONL file to extract metadata.
 * Returns null if the file can't be parsed or has no user messages.
 */
function parseSessionFile(filePath, maxLines) {
  if (maxLines == null) maxLines = 20;
  return new Promise(function (resolve) {
    var sessionId = path.basename(filePath, ".jsonl");
    var result = {
      sessionId: sessionId,
      firstPrompt: "",
      model: null,
      gitBranch: null,
      startTime: null,
      lastActivity: null,
    };

    var lineCount = 0;
    var foundUser = false;
    var stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (e) {
      return resolve(null);
    }

    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", function (line) {
      lineCount++;
      if (lineCount > maxLines) {
        rl.close();
        stream.destroy();
        return;
      }

      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; }

      // Skip file-history-snapshot, queue-operation, and other non-message records
      if (obj.type === "user" && obj.message && obj.message.role === "user") {
        if (!foundUser) {
          foundUser = true;
          result.sessionId = obj.sessionId || sessionId;
          result.gitBranch = obj.gitBranch || null;
          if (obj.timestamp) result.startTime = obj.timestamp;
          var content = obj.message.content || "";
          if (typeof content === "string") {
            result.firstPrompt = content.substring(0, 100);
          } else if (Array.isArray(content)) {
            for (var i = 0; i < content.length; i++) {
              if (content[i].type === "text" && content[i].text) {
                result.firstPrompt = content[i].text.substring(0, 100);
                break;
              }
            }
          }
        }
        // Track latest user timestamp for lastActivity
        if (obj.timestamp) result.lastActivity = obj.timestamp;
      }

      // Extract model from first assistant message
      if (!result.model && obj.message && obj.message.role === "assistant" && obj.message.model) {
        result.model = obj.message.model;
      }
    });

    rl.on("close", function () {
      if (!foundUser) return resolve(null);

      // Use file mtime as fallback for lastActivity, or as a better proxy
      // since we only read the first ~20 lines
      try {
        var stat = fs.statSync(filePath);
        var mtime = stat.mtime.toISOString();
        // File mtime is always more accurate for "last activity" since we
        // don't read the entire file
        result.lastActivity = mtime;
      } catch (e) {}

      resolve(result);
    });

    rl.on("error", function () {
      resolve(null);
    });

    stream.on("error", function () {
      rl.close();
      resolve(null);
    });
  });
}

/**
 * List CLI sessions for a given project directory.
 * Reads ~/.claude/projects/{encoded-cwd}/ and parses JSONL metadata.
 * Returns array sorted by lastActivity descending (most recent first).
 */
function listCliSessions(cwd) {
  var encoded = encodeCwd(cwd);
  var projectDir = path.join(REAL_HOME, ".claude", "projects", encoded);

  return new Promise(function (resolve) {
    fs.readdir(projectDir, { withFileTypes: true }, function (err, entries) {
      if (err) return resolve([]);

      var jsonlFiles = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isFile() && entries[i].name.endsWith(".jsonl")) {
          jsonlFiles.push(path.join(projectDir, entries[i].name));
        }
      }

      if (jsonlFiles.length === 0) return resolve([]);

      var pending = jsonlFiles.length;
      var results = [];

      for (var j = 0; j < jsonlFiles.length; j++) {
        parseSessionFile(jsonlFiles[j]).then(function (session) {
          if (session) results.push(session);
          pending--;
          if (pending === 0) {
            results.sort(function (a, b) {
              var ta = a.lastActivity || "";
              var tb = b.lastActivity || "";
              return ta < tb ? 1 : ta > tb ? -1 : 0;
            });
            resolve(results);
          }
        });
      }
    });
  });
}

/**
 * Get the most recent CLI session for a given project directory.
 * Returns the session object or null if none found.
 */
function getMostRecentCliSession(cwd) {
  return listCliSessions(cwd).then(function (sessions) {
    return sessions.length > 0 ? sessions[0] : null;
  });
}

/**
 * Extract user message text from a CLI JSONL content field.
 * Content can be a string or an array of content blocks.
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === "text" && content[i].text) {
      parts.push(content[i].text);
    }
  }
  return parts.join("");
}

/**
 * Read a full CLI session JSONL file and convert it to relay-compatible
 * history entries (user_message, delta, tool_start, tool_executing, tool_result).
 * Returns a Promise that resolves to an array of history entries.
 */
// Convert one parsed CLI jsonl record into client history entries. Shared by
// the streaming (async) and synchronous readers so the format stays in lockstep.
// `state.toolCounter` carries across lines to mint unique tool ids.
function appendCliRecord(obj, state, history) {
  if (!obj || !obj.message) return;

  // User prompt
  if (obj.type === "user" && obj.message.role === "user") {
    // Skip tool_result records (they have type "user" but content is tool results)
    var content = obj.message.content;
    if (Array.isArray(content) && content.length > 0 && content[0].type === "tool_result") {
      return;
    }
    var text = extractText(content);
    if (text) history.push({ type: "user_message", text: text });
    return;
  }

  // Assistant message
  if (obj.message.role === "assistant" && Array.isArray(obj.message.content)) {
    for (var i = 0; i < obj.message.content.length; i++) {
      var block = obj.message.content[i];

      if (block.type === "text" && block.text) {
        history.push({ type: "delta", text: block.text });
      }

      if (block.type === "tool_use") {
        var toolId = "cli-tool-" + (++state.toolCounter);
        var toolName = block.name || "Tool";
        history.push({ type: "tool_start", id: toolId, name: toolName });
        history.push({
          type: "tool_executing",
          id: toolId,
          name: toolName,
          input: block.input || {},
        });
        // Emit ask_user_answered so the client re-enables input after replaying AskUserQuestion
        if (toolName === "AskUserQuestion") {
          history.push({ type: "ask_user_answered", toolId: toolId });
        }
        history.push({ type: "tool_result", id: toolId, content: "" });
      }
    }
  }
}

function readCliSessionHistory(home, cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var filePath = path.join(home || REAL_HOME, ".claude", "projects", encoded, sessionId + ".jsonl");

  return new Promise(function (resolve) {
    var history = [];
    var stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (e) {
      return resolve([]);
    }

    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    var state = { toolCounter: 0 };

    rl.on("line", function (line) {
      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; }
      appendCliRecord(obj, state, history);
    });

    rl.on("close", function () {
      resolve(history);
    });

    rl.on("error", function () {
      resolve([]);
    });

    stream.on("error", function () {
      rl.close();
      resolve([]);
    });
  });
}

// Synchronous variant for callers that run inside a synchronous request
// handler (e.g. switch_session, which must populate session.history before
// the session_switched broadcast). Reads the whole jsonl - these transcripts
// are small enough that blocking on a local read is fine.
// Modified-time (ms) of a CLI session's jsonl, or 0 if missing. Lets callers
// cheaply detect that the transcript grew (e.g. after a TUI turn) and re-read.
function cliSessionFileMtime(home, cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var filePath = path.join(home || REAL_HOME, ".claude", "projects", encoded, sessionId + ".jsonl");
  try { return fs.statSync(filePath).mtimeMs; } catch (e) { return 0; }
}

function readCliSessionHistorySync(home, cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var filePath = path.join(home || REAL_HOME, ".claude", "projects", encoded, sessionId + ".jsonl");
  var raw;
  try { raw = fs.readFileSync(filePath, "utf8"); } catch (e) { return []; }
  var history = [];
  var state = { toolCounter: 0 };
  var lines = raw.split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var obj;
    try { obj = JSON.parse(lines[i]); } catch (e) { continue; }
    appendCliRecord(obj, state, history);
  }
  return history;
}

// Find the Codex rollout file for a thread id by scanning both the dated tree
// and the archived_sessions/ directory. Returns absolute path or null.
function findCodexRolloutPath(home, threadId, expectedCwd) {
  if (!threadId) return null;
  var base = path.join(home || REAL_HOME, ".codex", "sessions");
  var candidates = [];
  var years;
  try { years = fs.readdirSync(base); } catch (e) { years = []; }
  for (var yi = 0; yi < years.length; yi++) {
    var yDir = path.join(base, years[yi]);
    var months;
    try { months = fs.readdirSync(yDir); } catch (e) { continue; }
    for (var mi = 0; mi < months.length; mi++) {
      var mDir = path.join(yDir, months[mi]);
      var days;
      try { days = fs.readdirSync(mDir); } catch (e) { continue; }
      for (var di = 0; di < days.length; di++) {
        var dDir = path.join(mDir, days[di]);
        var files;
        try { files = fs.readdirSync(dDir); } catch (e) { continue; }
        for (var fi = 0; fi < files.length; fi++) {
          if (files[fi].indexOf("rollout-") === 0 && files[fi].endsWith(".jsonl") && files[fi].indexOf(threadId) !== -1) {
            candidates.push(path.join(dDir, files[fi]));
          }
        }
      }
    }
  }
  var archived = path.join(home || REAL_HOME, ".codex", "archived_sessions");
  var aFiles;
  try { aFiles = fs.readdirSync(archived); } catch (e) { aFiles = []; }
  for (var ai = 0; ai < aFiles.length; ai++) {
    if (aFiles[ai].indexOf("rollout-") === 0 && aFiles[ai].endsWith(".jsonl") && aFiles[ai].indexOf(threadId) !== -1) {
      candidates.push(path.join(archived, aFiles[ai]));
    }
  }
  // Confirm the session_meta payload matches before returning
  for (var ci = 0; ci < candidates.length; ci++) {
    var first;
    try { first = fs.readFileSync(candidates[ci], "utf8").split("\n", 1)[0]; } catch (e) { continue; }
    try {
      var ev = JSON.parse(first);
      if (ev && ev.type === "session_meta" && ev.payload && ev.payload.id === threadId) {
        if (!expectedCwd || !ev.payload.cwd || ev.payload.cwd === expectedCwd) {
          return candidates[ci];
        }
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

function codexRolloutMtime(home, threadId, expectedCwd) {
  var p = findCodexRolloutPath(home, threadId, expectedCwd);
  if (!p) return 0;
  try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; }
}

// Synchronously read a Codex rollout and synthesize a minimal Clay history of
// user + assistant text messages. Tool calls, exec output, reasoning, and
// patch_apply events are intentionally dropped — this is the "text-only" stub
// for imported sessions.
function readCodexHistorySync(home, threadId, expectedCwd) {
  var p = findCodexRolloutPath(home, threadId, expectedCwd);
  if (!p) return [];
  var raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) { return []; }
  var history = [];
  var lines = raw.split("\n");
  var sawFirstUser = false;
  function eventTs(ev) {
    var t = ev && ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    return isNaN(t) ? Date.now() : t;
  }
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var ev;
    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!ev || ev.type !== "event_msg" || !ev.payload) continue;
    var p2 = ev.payload;
    if (p2.type === "user_message" && typeof p2.message === "string") {
      var text = p2.message;
      // Filter out the noisy CLAUDE.md / AGENTS.md instructions Codex Desktop
      // injects as the first user turn — they aren't really a user prompt.
      if (!sawFirstUser && /^(---\s*Instructions from|<environment_context>|# AGENTS\.md|# CLAUDE\.md)/m.test(text)) {
        sawFirstUser = true;
        continue;
      }
      sawFirstUser = true;
      history.push({ type: "user_message", text: text, _ts: eventTs(ev) });
    } else if (p2.type === "agent_message" && typeof p2.message === "string") {
      var ts = eventTs(ev);
      history.push({ type: "delta", text: p2.message, _ts: ts });
      history.push({ type: "done", code: 0, _ts: ts + 1 });
    }
  }
  return history;
}

module.exports = {
  listCliSessions: listCliSessions,
  getMostRecentCliSession: getMostRecentCliSession,
  readCliSessionHistory: readCliSessionHistory,
  readCliSessionHistorySync: readCliSessionHistorySync,
  cliSessionFileMtime: cliSessionFileMtime,
  codexRolloutMtime: codexRolloutMtime,
  readCodexHistorySync: readCodexHistorySync,
  parseSessionFile: parseSessionFile,
  encodeCwd: encodeCwd,
  extractText: extractText,
};
