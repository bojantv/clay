// YOKE GitHub Copilot Adapter — stateless helpers
// -------------------------------------------------
// Pure helper functions extracted from github-copilot.js to keep the adapter
// module under the project's 500-line cap. None of these close over adapter
// instance state.

var fs = require("fs");
var { execFileSync } = require("child_process");
var { knownModelsForProvider } = require("../../provider-routes");

function createAsyncQueue() {
  var queue = [];
  var waiting = null;
  var ended = false;
  var error = null;

  function flush() {
    if (!waiting) return;
    var resolve = waiting.resolve;
    var reject = waiting.reject;
    waiting = null;
    if (error) {
      reject(error);
    } else if (queue.length > 0) {
      resolve({ value: queue.shift(), done: false });
    } else if (ended) {
      resolve({ value: undefined, done: true });
    } else {
      waiting = { resolve: resolve, reject: reject };
    }
  }

  return {
    push: function(item) {
      if (ended || error) return;
      queue.push(item);
      flush();
    },
    end: function() {
      ended = true;
      flush();
    },
    fail: function(err) {
      error = err || new Error("GitHub Copilot adapter failed");
      flush();
    },
    next: function() {
      if (error) return Promise.reject(error);
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise(function(resolve, reject) {
        waiting = { resolve: resolve, reject: reject };
      });
    },
  };
}

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function findCopilotPath() {
  if (process.env.COPILOT_CLI_PATH && fs.existsSync(process.env.COPILOT_CLI_PATH)) {
    return process.env.COPILOT_CLI_PATH;
  }
  try {
    var out = process.platform === "win32"
      ? execFileSync("where", ["copilot"], { timeout: 3000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      : execFileSync("which", ["copilot"], { timeout: 3000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return out.trim().split(/\r?\n/)[0] || null;
  } catch (e) {
  }
  var home = process.env.HOME || "";
  var candidates = [];
  if (home) {
    candidates.push(home + "/.npm-global/bin/copilot");
    candidates.push(home + "/.local/bin/copilot");
    candidates.push(home + "/.volta/bin/copilot");
    candidates.push(home + "/.bun/bin/copilot");
    candidates.push(home + "/bin/copilot");
  }
  candidates.push("/opt/homebrew/bin/copilot");
  candidates.push("/usr/local/bin/copilot");
  candidates.push("/usr/bin/copilot");
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) return candidates[i];
    } catch (e) {}
  }
  return null;
}

// Redact secrets before logging subprocess stderr. Copilot CLI stderr can echo
// auth tokens, bearer headers, or device-flow URLs on errors.
function redactSecrets(text) {
  return String(text || "")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[redacted-token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted-token]")
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[redacted-jwt]")
    .replace(/(authorization|bearer|token|api[_-]?key)(["'\s:=]+)\S+/gi, "$1$2[redacted]");
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch (e) {
    return "{}";
  }
}

function modelFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  return headers["x-copilot-model"] || headers["X-Copilot-Model"] || null;
}

function extractModelEvidence(value, source) {
  if (!value || typeof value !== "object") return null;
  var headerModel = modelFromHeaders(value.headers || value.responseHeaders);
  if (headerModel) return { model: headerModel, source: "header" };
  if (typeof value.model === "string") return { model: value.model, source: source || "response" };
  if (typeof value.actualModel === "string") return { model: value.actualModel, source: source || "response" };
  if (typeof value.currentModel === "string") return { model: value.currentModel, source: source || "response" };
  if (typeof value.modelId === "string") return { model: value.modelId, source: source || "response" };
  if (value.body && typeof value.body === "object") return extractModelEvidence(value.body, source || "response");
  if (value.response && typeof value.response === "object") return extractModelEvidence(value.response, source || "response");
  if (value.data && typeof value.data === "object") return extractModelEvidence(value.data, source || "response");
  if (value._meta && typeof value._meta === "object") return extractModelEvidence(value._meta, source || "metadata");
  return null;
}

function canonicalModelId(model) {
  return String(model || "").toLowerCase().replace(/[-.]/g, "");
}

function resolveKnownCopilotModel(model) {
  if (!model || model === "default" || model === "auto") return model;
  var wanted = canonicalModelId(model);
  var models = knownModelsForProvider("github-copilot");
  for (var i = 0; i < models.length; i++) {
    if (canonicalModelId(models[i]) === wanted) return models[i];
  }
  return model;
}

function textFromContentList(content) {
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    var item = content[i];
    if (!item) continue;
    if (item.type === "content" && item.content && item.content.type === "text") {
      parts.push(item.content.text || "");
    } else if (item.type === "diff") {
      parts.push("[diff]");
    } else if (item.type === "terminal") {
      parts.push("[terminal " + (item.terminalId || "") + "]");
    }
  }
  return parts.join("\n");
}

function runtimeMetadataPrompt(model, verifiedModel, verificationSource) {
  var selectedModel = model && model !== "default" ? model : "auto";
  var actualModelText = verifiedModel ? verifiedModel : "pending";
  var sourceText = verificationSource ? verificationSource : "none";
  var family = selectedModel.indexOf("gpt-") === 0 || selectedModel.indexOf("codex") !== -1
    ? "Codex/GPT-family"
    : (selectedModel.indexOf("claude-") === 0 ? "Claude-family" : "Copilot-selected");
  return "[Clay runtime metadata]\n" +
    "Provider: GitHub Copilot CLI.\n" +
    "Requested model: " + selectedModel + ".\n" +
    "Verified model: " + actualModelText + ".\n" +
    "Verification source: " + sourceText + ".\n" +
    "Model family: " + family + ".\n" +
    "This metadata describes the current runtime for this turn and overrides any older transcript, handoff text, or previous uncertainty.\n" +
    "If the user asks what provider, route, or model is active, answer from this metadata. If Verified model is not pending, treat it as authoritative. Do not introspect your own system prompt, speculate about another hidden model, hedge about silent downgrades, or repeat a different model from earlier conversation text.\n" +
    "[/Clay runtime metadata]";
}

function normalizePlanStatus(status) {
  if (status === "in_progress" || status === "completed") return status;
  return "pending";
}

function permissionResponse(params, toolPolicy) {
  var options = params.options || [];
  var selected = null;
  if (toolPolicy === "allow-all") {
    for (var i = 0; i < options.length; i++) {
      if (options[i].kind === "allow_always") selected = options[i];
    }
    if (!selected) {
      for (var j = 0; j < options.length; j++) {
        if (options[j].kind === "allow_once") selected = options[j];
      }
    }
  } else {
    for (var k = 0; k < options.length; k++) {
      if (options[k].kind === "reject_once" || options[k].kind === "reject_always") {
        selected = options[k];
        break;
      }
    }
  }
  if (!selected) selected = options[0] || null;
  if (!selected) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function modelConfigOption(options) {
  if (!Array.isArray(options)) return null;
  for (var i = 0; i < options.length; i++) {
    var option = options[i];
    if (!option) continue;
    if (option.id === "model" || option.category === "model") return option;
  }
  return null;
}

function resolveModelOptionValue(option, value) {
  if (!option || !value) return null;
  var wanted = canonicalModelId(value);
  var options = option.options || [];
  for (var i = 0; i < options.length; i++) {
    var item = options[i];
    if (!item) continue;
    if (item.value === value || canonicalModelId(item.value) === wanted) return item.value;
    var groupOptions = item.options || [];
    for (var j = 0; j < groupOptions.length; j++) {
      if (groupOptions[j] && (groupOptions[j].value === value || canonicalModelId(groupOptions[j].value) === wanted)) return groupOptions[j].value;
    }
  }
  return null;
}

module.exports = {
  createAsyncQueue: createAsyncQueue,
  delay: delay,
  findCopilotPath: findCopilotPath,
  redactSecrets: redactSecrets,
  safeJson: safeJson,
  modelFromHeaders: modelFromHeaders,
  extractModelEvidence: extractModelEvidence,
  canonicalModelId: canonicalModelId,
  resolveKnownCopilotModel: resolveKnownCopilotModel,
  textFromContentList: textFromContentList,
  runtimeMetadataPrompt: runtimeMetadataPrompt,
  normalizePlanStatus: normalizePlanStatus,
  permissionResponse: permissionResponse,
  modelConfigOption: modelConfigOption,
  resolveModelOptionValue: resolveModelOptionValue,
};
