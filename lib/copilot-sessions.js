var fs = require("fs");
var path = require("path");
var { REAL_HOME } = require("./config");

function sessionStateBase(home) {
  return path.join(home || REAL_HOME, ".copilot", "session-state");
}

function isSafeSessionId(sessionId) {
  return typeof sessionId === "string" && /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function sessionDir(home, sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  return path.join(sessionStateBase(home), sessionId);
}

function stripQuotes(value) {
  value = String(value || "").trim();
  if ((value[0] === "\"" && value[value.length - 1] === "\"") ||
      (value[0] === "'" && value[value.length - 1] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseYamlScalar(raw, key) {
  var re = new RegExp("^" + key + ":\\s*(.*)$", "m");
  var match = raw.match(re);
  if (!match) return "";
  return stripQuotes(match[1]);
}

function parseYamlBlock(raw, key) {
  var lines = raw.split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(key + ": |-") === 0 || lines[i].indexOf(key + ": |") === 0) {
      var out = [];
      for (var j = i + 1; j < lines.length; j++) {
        if (lines[j] && lines[j][0] !== " " && lines[j][0] !== "\t") break;
        out.push(lines[j].replace(/^  /, ""));
      }
      return out.join("\n").trim();
    }
  }
  return parseYamlScalar(raw, key);
}

function stripClayInjectedText(text) {
  text = String(text || "").replace(/\r/g, "");
  text = text.replace(/\[Clay runtime metadata\][\s\S]*?\[\/Clay runtime metadata\]/g, "");
  text = text.replace(/<current_datetime>[\s\S]*?<\/current_datetime>/g, "");
  text = text.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, "");
  text = text.replace(/<clay_handoff_context>[\s\S]*?<\/clay_handoff_context>/g, "");
  text = text.replace(/The prior transcript above is not the current user message\.[^\n]*(\n|$)/g, "");
  text = text.replace(/Wait for and answer only the user's latest message\.[^\n]*(\n|$)/g, "");
  text = text.replace(/<current_user_message>\s*([\s\S]*?)\s*<\/current_user_message>/g, "$1");
  text = text.replace(/Answer only the <current_user_message>[\s\S]*$/g, "");
  var separator = text.lastIndexOf("\n---\n");
  if (separator !== -1) text = text.slice(separator + 5);
  return text.trim();
}

function titleFromText(text) {
  var clean = stripClayInjectedText(text).replace(/\s+/g, " ").trim();
  if (clean.length > 80) clean = clean.slice(0, 77) + "...";
  return clean;
}

function modelFamily(model) {
  model = String(model || "").toLowerCase();
  if (!model || model === "auto" || model === "default") return "";
  if (model.indexOf("claude-") === 0) return "claude";
  if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "codex";
  return "";
}

function normalizeRuntimeModel(model) {
  return String(model || "").trim().replace(/[.,;:]+$/, "");
}

function firstRuntimeModel(text) {
  text = String(text || "");
  var verified = text.match(/Verified model:\s*([A-Za-z0-9_.-]+)/);
  if (verified && verified[1] && verified[1] !== "pending") return normalizeRuntimeModel(verified[1]);
  var requested = text.match(/Requested model:\s*([A-Za-z0-9_.-]+)/);
  return requested ? normalizeRuntimeModel(requested[1]) : "";
}

function eventTimestamp(ev) {
  var t = ev && ev.timestamp ? Date.parse(ev.timestamp) : NaN;
  return isNaN(t) ? Date.now() : t;
}

function readWorkspace(home, sessionId) {
  var dir = sessionDir(home, sessionId);
  if (!dir) return null;
  var workspacePath = path.join(dir, "workspace.yaml");
  var raw;
  try { raw = fs.readFileSync(workspacePath, "utf8"); } catch (e) { return null; }
  return {
    dir: dir,
    raw: raw,
    cwd: parseYamlScalar(raw, "cwd"),
    name: parseYamlBlock(raw, "name"),
    createdAt: parseYamlScalar(raw, "created_at"),
    updatedAt: parseYamlScalar(raw, "updated_at"),
  };
}

function readEventLines(eventsPath) {
  var raw;
  try { raw = fs.readFileSync(eventsPath, "utf8"); } catch (e) { return []; }
  return raw.split("\n");
}

function copilotSessionMtime(home, sessionId, expectedCwd) {
  var ws = readWorkspace(home, sessionId);
  if (!ws) return 0;
  if (expectedCwd && ws.cwd && ws.cwd !== expectedCwd) return 0;
  try { return fs.statSync(path.join(ws.dir, "events.jsonl")).mtimeMs; } catch (e) {}
  try { return fs.statSync(path.join(ws.dir, "workspace.yaml")).mtimeMs; } catch (e2) {}
  return 0;
}

function readCopilotHistorySync(home, sessionId, expectedCwd) {
  var ws = readWorkspace(home, sessionId);
  if (!ws) return [];
  if (expectedCwd && ws.cwd && ws.cwd !== expectedCwd) return [];
  var history = [];
  var lines = readEventLines(path.join(ws.dir, "events.jsonl"));
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var ev;
    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!ev || !ev.data) continue;
    if (ev.type === "user.message") {
      var userText = titleFromText(ev.data.content || "");
      if (!userText && ev.data.transformedContent) userText = titleFromText(ev.data.transformedContent);
      if (userText) history.push({ type: "user_message", text: userText, _ts: eventTimestamp(ev) });
    } else if (ev.type === "assistant.message" && typeof ev.data.content === "string" && ev.data.content.trim()) {
      var ts = eventTimestamp(ev);
      history.push({ type: "delta", text: ev.data.content, _ts: ts });
      history.push({ type: "done", code: 0, _ts: ts + 1 });
    }
  }
  return history;
}

function readCopilotSessionDescriptor(home, sessionId, expectedCwd) {
  var ws = readWorkspace(home, sessionId);
  if (!ws) return null;
  if (expectedCwd && ws.cwd && ws.cwd !== expectedCwd) return null;
  var mtime = copilotSessionMtime(home, sessionId, expectedCwd);
  if (!mtime) return null;
  var history = readCopilotHistorySync(home, sessionId, expectedCwd);
  var detectedModel = firstRuntimeModel(ws.name) || firstRuntimeModel(ws.raw);
  var detectedFamily = modelFamily(detectedModel);
  if (!detectedFamily) {
    var lines = readEventLines(path.join(ws.dir, "events.jsonl"));
    for (var li = 0; li < lines.length; li++) {
      if (!lines[li]) continue;
      var ev;
      try { ev = JSON.parse(lines[li]); } catch (e) { continue; }
      if (ev && ev.data && typeof ev.data.model === "string") {
        detectedModel = normalizeRuntimeModel(ev.data.model);
        detectedFamily = modelFamily(detectedModel);
        if (detectedFamily) break;
      }
    }
  }
  var firstUser = "";
  for (var i = 0; i < history.length; i++) {
    if (history[i].type === "user_message") {
      firstUser = history[i].text || "";
      break;
    }
  }
  if (!firstUser && !ws.name) return null;
  var createdAt = Date.now();
  var updatedAt = mtime;
  var created = Date.parse(ws.createdAt || "");
  var updated = Date.parse(ws.updatedAt || "");
  if (!isNaN(created)) createdAt = created;
  if (!isNaN(updated)) updatedAt = updated;
  var workspaceTitle = titleFromText(ws.name);
  if (workspaceTitle.indexOf("[Clay runtime metadata]") === 0 ||
      workspaceTitle.indexOf("Provider: GitHub Copilot CLI") !== -1) {
    workspaceTitle = "";
  }
  var title = firstUser || workspaceTitle || "Imported GitHub Copilot session";
  return {
    cliSid: sessionId,
    title: title,
    preview: firstUser || title,
    createdAt: createdAt,
    lastActivity: updatedAt || mtime,
    vendor: "github-copilot",
    copilotFamily: detectedFamily || null,
    model: detectedModel || null,
    providerRouteId: detectedFamily === "claude" ? "claude-github-copilot" : detectedFamily === "codex" ? "codex-github-copilot" : null,
  };
}

function listCopilotSessionDescriptors(home, expectedCwd) {
  var base = sessionStateBase(home);
  var entries;
  try { entries = fs.readdirSync(base); } catch (e) { return []; }
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var desc = readCopilotSessionDescriptor(home, entries[i], expectedCwd);
    if (desc) out.push(desc);
  }
  out.sort(function (a, b) { return (b.lastActivity || 0) - (a.lastActivity || 0); });
  return out;
}

module.exports = {
  copilotSessionMtime: copilotSessionMtime,
  listCopilotSessionDescriptors: listCopilotSessionDescriptors,
  readCopilotHistorySync: readCopilotHistorySync,
  readCopilotSessionDescriptor: readCopilotSessionDescriptor,
  stripClayInjectedText: stripClayInjectedText,
};
