// YOKE GitHub Copilot Adapter
// ---------------------------
// Uses GitHub Copilot CLI's ACP server (`copilot --acp --stdio`).

var { spawn } = require("child_process");
var stream = require("stream");
var { knownModelsForProvider } = require("../../provider-routes");
var helpers = require("./github-copilot-helpers");

var createAsyncQueue = helpers.createAsyncQueue;
var delay = helpers.delay;
var findCopilotPath = helpers.findCopilotPath;
var redactSecrets = helpers.redactSecrets;
var safeJson = helpers.safeJson;
var extractModelEvidence = helpers.extractModelEvidence;
var canonicalModelId = helpers.canonicalModelId;
var resolveKnownCopilotModel = helpers.resolveKnownCopilotModel;
var textFromContentList = helpers.textFromContentList;
var runtimeMetadataPrompt = helpers.runtimeMetadataPrompt;
var normalizePlanStatus = helpers.normalizePlanStatus;
var permissionResponse = helpers.permissionResponse;
var modelConfigOption = helpers.modelConfigOption;
var resolveModelOptionValue = helpers.resolveModelOptionValue;

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
  var cwd = opts.cwd || process.cwd();
  var toolPolicy = opts.toolPolicy || "ask";
  var executable = opts.executable;
  var procExited = false;
  var deathWaiters = [];

  function pushEvent(ev) {
    queue.push(ev);
  }

  // Promise that rejects when the CLI process dies, used to race against an
  // in-flight connection.prompt() so a closed stream can't strand the turn.
  function deathPromise() {
    if (procExited) return Promise.reject(new Error("GitHub Copilot CLI exited"));
    return new Promise(function(_resolve, reject) {
      deathWaiters.push(reject);
    });
  }

  function rejectDeathWaiters(err) {
    var waiters = deathWaiters;
    deathWaiters = [];
    for (var i = 0; i < waiters.length; i++) {
      try { waiters[i](err || new Error("GitHub Copilot CLI exited")); } catch (e) {}
    }
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

  async function applyModelConfig(options) {
    var desiredModel = requestedModel || model;
    if (!connection || !sessionId || !desiredModel || desiredModel === "default") return;
    var option = modelConfigOption(options);
    if (!option) return;
    modelConfigId = option.id || "model";
    var resolvedModel = resolveModelOptionValue(option, desiredModel);
    if (option.currentValue === desiredModel || canonicalModelId(option.currentValue) === canonicalModelId(desiredModel)) {
      model = option.currentValue;
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
      if (text.trim()) console.log("[github-copilot stderr]", redactSecrets(text.trim()));
    });
    proc.on("error", function(err) {
      procExited = true;
      rejectDeathWaiters(err);
      queue.fail(err);
    });
    proc.on("exit", function(code, signal) {
      procExited = true;
      var exitErr = (!closed && code !== 0)
        ? new Error("GitHub Copilot CLI exited: code=" + code + " signal=" + signal)
        : new Error("GitHub Copilot CLI exited");
      // Settle any in-flight prompt awaiting the connection so it can't hang
      // forever when the underlying stream closes mid-turn.
      rejectDeathWaiters(exitErr);
      if (!closed && code !== 0) {
        queue.fail(exitErr);
      } else {
        queue.end();
      }
    });

    var input = stream.Readable.toWeb(proc.stdout);
    var output = stream.Writable.toWeb(proc.stdin);
    var client = {
      requestPermission: function(params) {
        return Promise.resolve(permissionResponse(params, toolPolicy));
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
      var result = await Promise.race([
        connection.prompt({
          sessionId: sessionId,
          prompt: [{ type: "text", text: runtimeMetadataPrompt(model, actualModel, modelVerificationSource) + "\n\n" + (text || "") }],
        }),
        deathPromise(),
      ]);
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
      if (!initialized || !connection || !sessionId || !modelConfigId) return Promise.resolve();
      return connection.setSessionConfigOption({
        sessionId: sessionId,
        configId: modelConfigId,
        value: model,
      }).then(function(response) {
        var updatedOption = modelConfigOption(response && response.configOptions);
        if (updatedOption && updatedOption.currentValue) {
          model = updatedOption.currentValue;
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
      // Interrupt an in-flight turn so the user can stop a running prompt.
      if (connection && sessionId && (runningPrompt || pendingPrompts.length > 0)) {
        pendingPrompts = [];
        try { connection.cancel({ sessionId: sessionId }); } catch (e) {}
        return Promise.resolve(true);
      }
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
      // Don't silently lose queued prompts on teardown.
      if (pendingPrompts.length > 0) {
        console.log("[github-copilot] discarding " + pendingPrompts.length + " queued prompt(s) on close");
        pendingPrompts = [];
      }
      rejectDeathWaiters(new Error("GitHub Copilot session closed"));
      if (connection && sessionId) {
        try { connection.closeSession({ sessionId: sessionId }); } catch (e) {}
      }
      if (proc) {
        var deadProc = proc;
        try { deadProc.kill("SIGTERM"); } catch (e) {}
        // Escalate to SIGKILL if the CLI doesn't exit promptly.
        setTimeout(function() {
          try { if (!deadProc.killed) deadProc.kill("SIGKILL"); } catch (e) {}
        }, 2000);
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
