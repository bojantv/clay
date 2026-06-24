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
    // Authorization header: redact the whole value (incl. "Bearer <token>").
    .replace(/\bauthorization\s*[:=]\s*[^\r\n]+/gi, "authorization: [redacted]")
    // Bare "Bearer <token>" and key=value forms.
    .replace(/\bbearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b(token|api[_-]?key)(["'\s:=]+)\S+/gi, "$1$2[redacted]");
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

// Convert ACP per-turn token usage into Clay's usage shape.
//
// Source: the `usage` field on an ACP PromptResponse (the `Usage` type in
// @agentclientprotocol/sdk v0.25.0). Per the schema, inputTokens/outputTokens/
// cachedReadTokens/cachedWriteTokens are CUMULATIVE session running totals
// ("Total ... across all turns"), not per-turn values. Clay's usage panel
// accumulates (+=) per-turn deltas, so we diff against the previous turn's
// cumulative totals to recover the delta. Deltas are clamped to >= 0 to stay
// robust if a future CLI ever resets or reorders counters.
//
// Returns null when no usage is present so downstream can show "unknown"
// instead of a misleading zero. The `previous` argument is the prior turn's
// raw cumulative Usage object (or null on the first turn).
function copilotTurnUsage(current, previous) {
  if (!current) return null;
  previous = previous || {};
  function delta(curVal, prevVal) {
    var d = (curVal || 0) - (prevVal || 0);
    return d > 0 ? d : 0;
  }
  return {
    input_tokens: delta(current.inputTokens, previous.inputTokens),
    output_tokens: delta(current.outputTokens, previous.outputTokens),
    cache_read_input_tokens: delta(current.cachedReadTokens, previous.cachedReadTokens),
    cache_creation_input_tokens: delta(current.cachedWriteTokens, previous.cachedWriteTokens),
  };
}

// Map an ACP StopReason to a human-readable truncation note, or null when the
// turn ended normally. Per @agentclientprotocol/sdk v0.25.0, max_tokens and
// max_turn_requests mean the response was cut off before completing.
function copilotTruncation(stopReason) {
  if (stopReason === "max_tokens") return "the response hit the output token limit";
  if (stopReason === "max_turn_requests") return "the response hit the maximum number of tool/request turns";
  return null;
}

async function startCopilotSession(connection, capabilities, opts) {
  opts = opts || {};
  var base = { cwd: opts.cwd, mcpServers: opts.mcpServers || [] };
  var sessionId = opts.sessionId || null;
  var canResume = !!(sessionId && capabilities && capabilities.sessionCapabilities && capabilities.sessionCapabilities.resume);
  var canLoad = !!(sessionId && capabilities && capabilities.loadSession);
  if (canResume || canLoad) {
    try {
      if (canResume) return await connection.resumeSession(Object.assign({}, base, { sessionId: sessionId }));
      return await connection.loadSession(Object.assign({}, base, { sessionId: sessionId }));
    } catch (resumeErr) {
      // The Copilot CLI keeps ACP sessions in the (now-dead) child process, so
      // after a daemon or CLI restart the stored id is gone and resume/load
      // rejects with "Invalid params". Fall back to a fresh session instead of
      // hard-failing the turn — Clay re-injects conversation context, so the
      // only thing lost is the provider's native rollout, not the chat.
      console.error("[yoke/github-copilot] resume/load of session " + sessionId +
        " failed (" + ((resumeErr && resumeErr.message) || resumeErr) + "); starting a fresh session");
    }
  }
  return connection.newSession(base);
}

function copilotSupportsPromptImages(capabilities) {
  return !!(capabilities && capabilities.promptCapabilities && capabilities.promptCapabilities.image === true);
}

function copilotPromptBlocks(runtimeText, text, images, allowImages) {
  var promptText = runtimeText + "\n\n" + (text || "");
  var blocks = [{ type: "text", text: promptText }];
  if (images && images.length > 0 && allowImages) {
    for (var i = 0; i < images.length; i++) {
      if (images[i] && images[i].data && images[i].mediaType) {
        blocks.push({ type: "image", data: images[i].data, mimeType: images[i].mediaType });
      }
    }
  } else if (images && images.length > 0) {
    blocks[0].text += "\n\n[Clay note: The user attached " + images.length + " image(s), but this GitHub Copilot ACP session does not advertise image prompt support. Ask the user to switch to a vision-capable route or describe the image if visual details are required.]";
  }
  return blocks;
}

module.exports = {
  createAsyncQueue: createAsyncQueue,
  copilotTurnUsage: copilotTurnUsage,
  copilotTruncation: copilotTruncation,
  copilotPromptBlocks: copilotPromptBlocks,
  copilotSupportsPromptImages: copilotSupportsPromptImages,
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
  startCopilotSession: startCopilotSession,
};
