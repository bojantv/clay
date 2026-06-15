// YOKE GitHub Copilot Adapter
// ---------------------------
// Uses GitHub Copilot CLI's ACP server (`copilot --acp --stdio`).

var fs = require("fs");
var { spawn, execFileSync } = require("child_process");
var stream = require("stream");
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

function createCopilotQueryHandle(opts) {
  opts = opts || {};
  var queue = createAsyncQueue();
  var acp = null;
  var proc = null;
  var connection = null;
  var sessionId = null;
  var initialized = false;
  var closed = false;
  var runningPrompt = false;
  var pendingPrompts = [];
  var seenTextMessages = {};
  var seenThinkingMessages = {};
  var tools = {};
  var usage = null;
  var promptErrorText = null;
  var modelErrorText = null;
  var modelConfigId = null;
  var actualModel = null;
  var modelVerificationSource = null;
  var requestedModel = resolveKnownCopilotModel(opts.model || "auto");
  var model = requestedModel;
  var modelConfigApplied = false;
  var cwd = opts.cwd || process.cwd();
  var toolPolicy = opts.toolPolicy || "ask";
  var executable = opts.executable;

  function pushEvent(ev) {
    queue.push(ev);
  }

  function rememberActualModel(found) {
    if (!found || !found.model) return;
    actualModel = found.model;
    modelVerificationSource = found.source || "response";
    pushEvent({
      yokeType: "model_verified",
      model: actualModel,
      requestedModel: requestedModel || model || null,
      source: modelVerificationSource,
    });
  }

  function permissionResponse(params) {
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

  function emitToolCall(update) {
    var id = update.toolCallId;
    if (!id) return;
    tools[id] = Object.assign({}, tools[id] || {}, update);
    if (update.sessionUpdate === "tool_call") {
      pushEvent({
        yokeType: "tool_start",
        blockId: "tool_" + id,
        toolId: id,
        toolName: update.title || update.kind || "copilot_tool",
      });
      if (update.rawInput) {
        pushEvent({
          yokeType: "tool_input_delta",
          blockId: "tool_" + id,
          partialJson: safeJson(update.rawInput),
        });
      }
    }
    if (update.status === "in_progress") {
      pushEvent({
        yokeType: "tool_executing",
        toolId: id,
        toolName: update.title || update.kind || "copilot_tool",
        input: update.rawInput || {},
      });
    }
    if (update.status === "completed" || update.status === "failed") {
      pushEvent({
        yokeType: "tool_result",
        toolId: id,
        content: textFromContentList(update.content) || (update.rawOutput ? safeJson(update.rawOutput) : ""),
        isError: update.status === "failed",
      });
    }
  }

  function emitPlan(update) {
    var entries = update.entries || [];
    var plan = [];
    for (var i = 0; i < entries.length; i++) {
      plan.push({
        step: entries[i].content || "",
        status: normalizePlanStatus(entries[i].status),
      });
    }
    pushEvent({ yokeType: "plan_updated", explanation: "", plan: plan });
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

  async function applyModelConfig(options) {
    var desiredModel = requestedModel || model;
    if (!connection || !sessionId || !desiredModel || desiredModel === "default") return;
    var option = modelConfigOption(options);
    if (!option) return;
    modelConfigId = option.id || "model";
    var resolvedModel = resolveModelOptionValue(option, desiredModel);
    if (option.currentValue === desiredModel || canonicalModelId(option.currentValue) === canonicalModelId(desiredModel)) {
      model = option.currentValue;
      modelConfigApplied = true;
      rememberActualModel({ model: model, source: "config" });
      return;
    }
    if (!resolvedModel) {
      modelErrorText = "GitHub Copilot does not expose model '" + desiredModel + "' for this account.";
      return;
    }
    model = resolvedModel;
    var response = await connection.setSessionConfigOption({
      sessionId: sessionId,
      configId: modelConfigId,
      value: model,
    });
    var updatedOption = modelConfigOption(response && response.configOptions);
    if (updatedOption && updatedOption.currentValue && updatedOption.currentValue !== model) {
      modelErrorText = "GitHub Copilot kept model '" + updatedOption.currentValue + "' instead of requested model '" + model + "'.";
    } else if (updatedOption && updatedOption.currentValue) {
      model = updatedOption.currentValue;
      modelConfigApplied = true;
      rememberActualModel({ model: model, source: "config" });
    }
  }

  function handleSessionUpdate(params) {
    if (!params || !params.update) return Promise.resolve();
    var update = params.update;
    var updateModelEvidence = extractModelEvidence(update, null);
    if (updateModelEvidence) rememberActualModel(updateModelEvidence);
    if (update.sessionUpdate === "agent_message_chunk" && update.content && update.content.type === "text") {
      var messageText = update.content.text || "";
      if (messageText.indexOf("You are not authorized to use this Copilot feature") !== -1) {
        promptErrorText = messageText;
        return Promise.resolve();
      }
      var msgId = update.messageId || "copilot_text";
      if (!seenTextMessages[msgId]) {
        seenTextMessages[msgId] = true;
        pushEvent({ yokeType: "text_start", blockId: msgId });
      }
      pushEvent({ yokeType: "text_delta", blockId: msgId, text: messageText });
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content && update.content.type === "text") {
      var thoughtId = update.messageId || "copilot_thinking";
      if (!seenThinkingMessages[thoughtId]) {
        seenThinkingMessages[thoughtId] = true;
        pushEvent({ yokeType: "thinking_start", blockId: thoughtId });
      }
      pushEvent({ yokeType: "thinking_delta", blockId: thoughtId, text: update.content.text || "" });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      emitToolCall(update);
    } else if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
      emitPlan(update);
    } else if (update.sessionUpdate === "usage_update") {
      usage = update;
    } else if (update.sessionUpdate === "config_option_update") {
      var configModel = modelConfigOption(update.configOptions || []);
      if (configModel && configModel.currentValue) {
        if (requestedModel && requestedModel !== "default" && requestedModel !== "auto" && canonicalModelId(configModel.currentValue) !== canonicalModelId(requestedModel)) {
          return Promise.resolve();
        }
        model = configModel.currentValue;
        modelConfigApplied = true;
        rememberActualModel({ model: model, source: "config" });
      }
    } else if (update.sessionUpdate === "current_mode_update") {
      pushEvent({ yokeType: "status", status: update.currentModeId || "mode_changed" });
    }
    return Promise.resolve();
  }

  async function ensureStarted() {
    if (initialized) return;
    acp = await import("@agentclientprotocol/sdk");
    var args = ["--acp", "--stdio"];
    if (model && model !== "default") args.push("--model=" + model);
    if (toolPolicy === "allow-all") args.push("--allow-all");
    proc = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    proc.stderr.on("data", function(chunk) {
      var text = chunk.toString();
      if (text.trim()) console.log("[github-copilot stderr]", text.trim());
    });
    proc.on("error", function(err) {
      queue.fail(err);
    });
    proc.on("exit", function(code, signal) {
      if (!closed && code !== 0) {
        queue.fail(new Error("GitHub Copilot CLI exited: code=" + code + " signal=" + signal));
      } else {
        queue.end();
      }
    });

    var input = stream.Readable.toWeb(proc.stdout);
    var output = stream.Writable.toWeb(proc.stdin);
    var client = {
      requestPermission: function(params) {
        return Promise.resolve(permissionResponse(params));
      },
      sessionUpdate: handleSessionUpdate,
      readTextFile: function() {
        return Promise.resolve({ content: "" });
      },
      writeTextFile: function() {
        return Promise.resolve({});
      },
    };
    connection = new acp.ClientSideConnection(function() { return client; }, acp.ndJsonStream(output, input));
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    var session = await connection.newSession({
      cwd: cwd,
      mcpServers: [],
    });
    sessionId = session.sessionId;
    await applyModelConfig(session.configOptions || []);
    pushEvent({ yokeType: "init", model: model, skills: [], slashCommands: [] });
    initialized = true;
  }

  async function runPrompt(text) {
    await ensureStarted();
    if (modelErrorText) {
      pushEvent({ yokeType: "turn_start" });
      pushEvent({
        yokeType: "result",
        cost: 0,
        duration: null,
        usage: null,
        modelUsage: null,
        sessionId: sessionId,
        subtype: "error_during_execution",
        errors: [modelErrorText],
      });
      return;
    }
    runningPrompt = true;
    promptErrorText = null;
    pushEvent({ yokeType: "turn_start" });
    try {
      var result = await connection.prompt({
        sessionId: sessionId,
        prompt: [{ type: "text", text: runtimeMetadataPrompt(model, actualModel, modelVerificationSource) + "\n\n" + (text || "") }],
      });
      var resultModelEvidence = extractModelEvidence(result, "response");
      if (resultModelEvidence) rememberActualModel(resultModelEvidence);
      await delay(150);
      if (promptErrorText) {
        pushEvent({
          yokeType: "result",
          cost: 0,
          duration: null,
          usage: null,
          modelUsage: null,
          sessionId: sessionId,
          subtype: "error_during_execution",
          errors: [promptErrorText],
        });
        return;
      }
      pushEvent({
        yokeType: "result",
        cost: usage && usage.cost ? usage.cost.amount : null,
        duration: null,
        usage: usage ? { input_tokens: usage.used || 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : null,
        modelUsage: {},
        sessionId: sessionId,
        requestedModel: requestedModel || model || null,
        verifiedModel: actualModel || null,
        modelVerificationSource: modelVerificationSource || null,
        subtype: result && result.stopReason === "error" ? "error_during_execution" : null,
      });
    } catch (e) {
      pushEvent({
        yokeType: "result",
        cost: 0,
        duration: null,
        usage: null,
        modelUsage: null,
        sessionId: sessionId,
        subtype: "error_during_execution",
        errors: [e.message || String(e)],
      });
    } finally {
      runningPrompt = false;
      if (pendingPrompts.length > 0 && !closed) {
        var next = pendingPrompts.shift();
        runPrompt(next).catch(function(err) { queue.fail(err); });
      }
    }
  }

  if (opts.prompt) {
    runPrompt(opts.prompt).catch(function(err) { queue.fail(err); });
  }

  return {
    [Symbol.asyncIterator]: function() {
      return {
        next: function() { return queue.next(); },
      };
    },
    pushMessage: function(text) {
      if (closed) return;
      if (runningPrompt) pendingPrompts.push(text || "");
      else runPrompt(text || "").catch(function(err) { queue.fail(err); });
    },
    setModel: function(nextModel) {
      requestedModel = resolveKnownCopilotModel(nextModel || requestedModel || model);
      model = requestedModel;
      modelConfigApplied = false;
      if (!initialized || !connection || !sessionId || !modelConfigId) return Promise.resolve();
      return connection.setSessionConfigOption({
        sessionId: sessionId,
        configId: modelConfigId,
        value: model,
      }).then(function(response) {
        var updatedOption = modelConfigOption(response && response.configOptions);
        if (updatedOption && updatedOption.currentValue) {
          model = updatedOption.currentValue;
          modelConfigApplied = true;
          rememberActualModel({ model: model, source: "config" });
        }
      });
    },
    setEffort: function() {
      return Promise.resolve();
    },
    setToolPolicy: function(policy) {
      toolPolicy = policy || toolPolicy;
      return Promise.resolve();
    },
    stopTask: function() {
      return Promise.resolve(false);
    },
    getContextUsage: function() {
      if (!usage) return Promise.resolve(null);
      return Promise.resolve({
        contextWindow: usage.size || 0,
        inputTokens: usage.used || 0,
        maxOutputTokens: 0,
        model: model,
      });
    },
    abort: function() {
      if (connection && sessionId) {
        try { connection.cancel({ sessionId: sessionId }); } catch (e) {}
      }
    },
    close: function() {
      closed = true;
      if (connection && sessionId) {
        try { connection.closeSession({ sessionId: sessionId }); } catch (e) {}
      }
      if (proc) {
        try { proc.kill("SIGTERM"); } catch (e) {}
      }
      queue.end();
    },
  };
}

function createGitHubCopilotAdapter(opts) {
  opts = opts || {};
  var _cwd = opts.cwd || process.cwd();
  var _copilotPath = findCopilotPath();
  var _models = knownModelsForProvider("github-copilot");

  return {
    vendor: "github-copilot",
    init: function() {
      _copilotPath = findCopilotPath();
      if (!_copilotPath) return Promise.reject(new Error("GitHub Copilot CLI is not installed. Install @github/copilot or set COPILOT_CLI_PATH."));
      return Promise.resolve({
        defaultModel: "auto",
        models: _models.slice(),
        skills: [],
        slashCommands: [],
        capabilities: {},
      });
    },
    supportedModels: function() {
      return Promise.resolve(_models.slice());
    },
    createToolServer: function() {
      return null;
    },
    createQuery: function(queryOpts) {
      queryOpts = Object.assign({}, queryOpts || {});
      if (!_copilotPath) _copilotPath = findCopilotPath();
      if (!_copilotPath) throw new Error("GitHub Copilot CLI is not installed. Run: npm install -g @github/copilot");
      return createCopilotQueryHandle({
        executable: _copilotPath,
        cwd: queryOpts.cwd || _cwd,
        prompt: queryOpts.prompt || "",
        model: queryOpts.model || "auto",
        toolPolicy: queryOpts.toolPolicy || "ask",
      });
    },
    generateTitle: function(messages) {
      var first = messages && messages[0] ? String(messages[0]) : "GitHub Copilot session";
      first = first.replace(/\s+/g, " ").trim();
      if (first.length > 60) first = first.substring(0, 60);
      return Promise.resolve(first || "GitHub Copilot session");
    },
  };
}

module.exports = {
  createGitHubCopilotAdapter: createGitHubCopilotAdapter,
  findCopilotPath: findCopilotPath,
};
