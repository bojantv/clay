var usersModule = require("./users");
var { listProviderRoutes, routeForId, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");
var sessionWorktree = require("./session-worktree");

function attachMessageProcessor(ctx) {
  var sm = ctx.sm;
  var send = ctx.send;
  var slug = ctx.slug;
  var isMate = ctx.isMate;
  var mateDisplayName = ctx.mateDisplayName;
  var pushModule = ctx.pushModule;
  var getNotificationsModule = ctx.getNotificationsModule || function () { return null; };
  var getSDK = ctx.getSDK;
  var adapter = ctx.adapter;
  var cwd = ctx.cwd;
  var onProcessingChanged = ctx.onProcessingChanged;
  var onTurnDone = ctx.onTurnDone;
  var onAutoTitle = ctx.onAutoTitle;
  var opts = ctx.opts;
  var discoverSkillDirs = ctx.discoverSkillDirs;
  var mergeSkills = ctx.mergeSkills;
  var isTransientStreamError = ctx.isTransientStreamError || function () { return false; };
  var autoResumeAllowed = ctx.autoResumeAllowed || function () { return false; };
  var scheduleInterruptResume = ctx.scheduleInterruptResume || null;

  // Auto-resume a turn whose only output was a transient "API Error:" delivered
  // in-band (assistant message + normal result, not a thrown error) — e.g. the
  // SDK's "socket connection was closed unexpectedly". Mirrors the thrown-error
  // and truncated-stream retry policy: one shot, budget-capped, never on a user
  // stop. Returns true if a resume was scheduled.
  function maybeAutoResumeTransientApiError(session, text, requireApiPrefix) {
    if (!session || !text || !scheduleInterruptResume) return false;
    var t = String(text).trim();
    if (requireApiPrefix && !/^API Error:/i.test(t)) return false;
    if (!isTransientStreamError(t)) return false;
    if (session.taskStopRequested || session._transientRetryUsed) return false;
    if (!autoResumeAllowed(session)) return false;
    session._transientRetryUsed = true;
    sendAndRecord(session, { type: "info", text: "Connection dropped mid-response. Retrying…", variant: "recovery" });
    scheduleInterruptResume(session);
    return true;
  }

  var AUTO_TITLE_TURN_THRESHOLD = 2;

  function getMateIdForNotification() {
    if (!isMate) return null;
    if (typeof slug === "string" && slug.indexOf("mate-") === 0) {
      return slug.substring(5) || null;
    }
    return null;
  }

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
  }

  function providerDisplayName(session) {
    if (session && session.providerRouteId) {
      var route = routeForId(session.providerRouteId);
      if (route && route.label) return route.label;
    }
    var vendor = session && session.vendor ? session.vendor : ((adapter && adapter.vendor) || "claude");
    if (vendor === "codex") return "Codex";
    if (vendor === "github-copilot") return "GitHub Copilot";
    return "Claude";
  }

  function normalizeExecutionError(session, text) {
    var msg = text || "Unknown SDK error";
    if (session && session.vendor === "github-copilot" &&
        msg.indexOf("You are not authorized to use this Copilot feature") !== -1) {
      return "GitHub Copilot is installed and logged in, but this account or organization is not authorized to use the Copilot CLI agent/ACP feature. Enable the required Copilot policy for your GitHub organization/account, then retry. Original error: " + msg;
    }
    return msg;
  }

  function sendToSession(session, obj) {
    sm.sendToSession(session, obj);
  }

  function getModelsForSession(session, vendor) {
    if (vendor === "github-copilot") {
      var copilotModels = knownModelsForProvider("github-copilot");
      if (copilotModels.length > 0) return copilotModels;
    }
    if (session && session.providerRouteId) {
      var route = routeForId(session.providerRouteId);
      var routeModels = knownModelsForRoute(route);
      if (routeModels.length > 0) return routeModels;
    }
    if (vendor && sm.modelsByVendor && sm.modelsByVendor[vendor]) return sm.modelsByVendor[vendor];
    return sm.availableModels || [];
  }

  function copilotRouteIdForModel(model) {
    if (!model) return null;
    if (model.indexOf("claude-") === 0) return "claude-github-copilot";
    if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "codex-github-copilot";
    return null;
  }

  function canonicalModelId(model) {
    return String(model || "").toLowerCase().replace(/[-.]/g, "");
  }

  function modelListContains(list, modelId) {
    if (!list || !modelId) return false;
    var wanted = canonicalModelId(modelId);
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      var value = typeof entry === "string" ? entry : (entry && (entry.value || entry.id)) || "";
      if (canonicalModelId(value) === wanted) return true;
    }
    return false;
  }

  function applyModelVerification(session, parsed) {
    if (!session || !parsed || !parsed.model) return;
    // Dedup: if this exact model was already verified, skip the redundant
    // saveSessionFile + broadcastSessionList + model_verified send this turn.
    if (session.verifiedModel === parsed.model) return;
    // Validate the provider-supplied model against the known model list for the
    // session before persisting. An unknown value must not overwrite
    // session.model / providerRouteId. Only enforce when we actually have a
    // non-empty list to check against (unknown vendors have no list).
    var verificationVendor = session.vendor || ((adapter && adapter.vendor) || null);
    var knownModels = getModelsForSession(session, verificationVendor);
    if (knownModels && knownModels.length > 0 && !modelListContains(knownModels, parsed.model)) {
      console.warn("[sdk-message-processor] ignoring unknown verified model for session " + session.localId + ": " + parsed.model);
      return;
    }
    session.verifiedModel = parsed.model;
    session.requestedModel = parsed.requestedModel || session.requestedModel || session.model || null;
    session.modelVerificationSource = parsed.source || parsed.modelVerificationSource || "response";
    if ((session.vendor || ((adapter && adapter.vendor) || null)) === "github-copilot") {
      session.model = session.verifiedModel;
      var verifiedRouteId = copilotRouteIdForModel(session.verifiedModel);
      if (verifiedRouteId) session.providerRouteId = verifiedRouteId;
    }
    try { sm.saveSessionFile(session); } catch (e) {}
    if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    sendToSession(session, {
      type: "model_verified",
      model: session.verifiedModel,
      requestedModel: session.requestedModel,
      source: session.modelVerificationSource,
      vendor: session.vendor || ((adapter && adapter.vendor) || null),
      providerRouteId: session.providerRouteId || null,
    });
  }

  function toolActivityTextForSubagent(name, input) {
    if (name === "Bash" && input && input.description) return input.description;
    if (name === "Read" && input && input.file_path) return "Reading " + input.file_path.split("/").pop();
    if (name === "Edit" && input && input.file_path) return "Editing " + input.file_path.split("/").pop();
    if (name === "Write" && input && input.file_path) return "Writing " + input.file_path.split("/").pop();
    if (name === "Grep" && input && input.pattern) return "Searching for " + input.pattern;
    if (name === "Glob" && input && input.pattern) return "Finding " + input.pattern;
    if (name === "WebSearch" && input && input.query) return "Searching: " + input.query;
    if (name === "WebFetch") return "Fetching URL...";
    if (name === "Task" && input && input.description) return input.description;
    return "Running " + name + "...";
  }

  function processSubagentMessage(session, parsed) {
    var parentId = parsed.parentToolUseId;
    var content = parsed.content;
    if (!Array.isArray(content)) return;

    if (parsed.messageRole === "assistant") {
      // Extract tool_use blocks from sub-agent assistant messages
      for (var i = 0; i < content.length; i++) {
        var block = content[i];
        if (block.type === "tool_use") {
          var activityText = toolActivityTextForSubagent(block.name, block.input);
          sendAndRecord(session, {
            type: "subagent_tool",
            parentToolId: parentId,
            toolName: block.name,
            toolId: block.id,
            text: activityText,
          });
        } else if (block.type === "thinking") {
          sendAndRecord(session, {
            type: "subagent_activity",
            parentToolId: parentId,
            text: "Thinking...",
          });
        } else if (block.type === "text" && block.text) {
          sendAndRecord(session, {
            type: "subagent_activity",
            parentToolId: parentId,
            text: "Writing response...",
          });
        }
      }
    }
    // user messages with parentToolUseId contain tool_results -- skip silently
  }

  function processSDKMessage(session, parsed) {
    if (session) session._lastStreamEventAt = Date.now();
    // Timing: log key SDK milestones relative to query start
    if (session._queryStartTs) {
      var _elapsed = Date.now() - session._queryStartTs;
      if (parsed.yokeType === "init") {
        console.log("[PERF] processSDKMessage: system/init +" + _elapsed + "ms");
      }
      if (parsed.yokeType === "turn_start") {
        console.log("[PERF] processSDKMessage: message_start (API response begun) +" + _elapsed + "ms");
      }
      if ((parsed.yokeType === "text_delta" || parsed.yokeType === "tool_input_delta" || parsed.yokeType === "thinking_delta") && !session._firstTextLogged) {
        session._firstTextLogged = true;
        console.log("[PERF] processSDKMessage: FIRST content_block_delta (visible text) +" + _elapsed + "ms");
      }
      if (parsed.yokeType === "result") {
        console.log("[PERF] processSDKMessage: result +" + _elapsed + "ms");
      }
    }

    // Extract session_id from any message that carries it
    if (parsed.sessionId && !session.cliSessionId) {
      if (!session.storageId) session.storageId = parsed.sessionId;
      session.cliSessionId = parsed.sessionId;
      sm.saveSessionFile(session);
      sendAndRecord(session, { type: "session_id", cliSessionId: session.cliSessionId });
    } else if (parsed.sessionId && parsed.sessionId !== session.cliSessionId) {
      if (!session.storageId) session.storageId = session.cliSessionId;
      session.cliSessionId = parsed.sessionId;
      sm.saveSessionFile(session);
    } else if (parsed.sessionId) {
      session.cliSessionId = parsed.sessionId;
    }

    // Capture message UUIDs for rewind support
    if (parsed.uuid) {
      if (parsed.messageType === "user" && !parsed.parentToolUseId) {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "user", historyIndex: session.history.length });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "user" });
      } else if (parsed.messageType === "assistant") {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "assistant", historyIndex: session.history.length });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "assistant" });
      }
    }

    // Cache slash_commands and model from CLI init message
    if (parsed.yokeType === "init") {
      var fsSkills = discoverSkillDirs();
      sm.skillNames = mergeSkills(parsed.skills, fsSkills);
      if (parsed.slashCommands) {
        // Union: SDK slash_commands + merged skills (deduplicated)
        var seen = new Set();
        var combined = [];
        var all = parsed.slashCommands.concat(Array.from(sm.skillNames));
        for (var k = 0; k < all.length; k++) {
          if (!seen.has(all[k])) {
            seen.add(all[k]);
            combined.push(all[k]);
          }
        }
        sm.slashCommands = combined;
        send({ type: "slash_commands", commands: sm.slashCommands });
      }
      if (parsed.model) {
        var initVendor = session.vendor || (adapter && adapter.vendor) || "claude";
        var initModels = getModelsForSession(session, initVendor);
        if (initVendor === "github-copilot") {
          if (modelListContains(initModels, parsed.model)) {
            sm.currentModel = parsed.model;
            session.model = parsed.model;
            var parsedRouteId = copilotRouteIdForModel(parsed.model);
            if (parsedRouteId) session.providerRouteId = parsedRouteId;
            try { sm.saveSessionFile(session); } catch (e) {}
            if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
          }
        } else {
          sm.currentModel = sm.currentModel || sm._savedDefaultModel || parsed.model;
        }
        var modelToSend = "";
        if (modelListContains(initModels, session.model)) {
          modelToSend = session.model;
        } else if (modelListContains(initModels, sm.currentModel)) {
          modelToSend = sm.currentModel;
        }
        if (!modelToSend && initModels.length > 0) {
          var firstInitModel = initModels[0];
          modelToSend = typeof firstInitModel === "string" ? firstInitModel : (firstInitModel && (firstInitModel.value || firstInitModel.id)) || "";
        }
        sendToSession(session, {
          type: "model_info",
          model: modelToSend,
          models: initModels,
          vendor: initVendor,
          providerRouteId: session.providerRouteId || null,
          requestedModel: session.requestedModel || session.model || null,
          verifiedModel: session.verifiedModel || null,
          modelVerificationSource: session.modelVerificationSource || null,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
          providerRoutes: sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []),
        });
      }
      if (parsed.fastModeState) {
        sendAndRecord(session, { type: "fast_mode_state", state: parsed.fastModeState });
      }
    }

    if (parsed.yokeType === "turn_start") {
      if (!session.isProcessing) {
        session.isProcessing = true;
        onProcessingChanged();
        sendToSession(session, { type: "status", status: "processing" });
        sm.broadcastSessionList();
      }
      session.blocks = {};
      session.sentToolResults = {};
      session.streamedText = false;
      session.responsePreview = "";
      // Reset the task-workflow response accumulator so stale text can't leak
      // into the next turn's completion-marker check or grow unbounded.
      session._taskWorkflowResponseText = "";
      session._firstTextLogged = false;
      if (parsed.inputTokens) {
        session.lastStreamInputTokens = parsed.inputTokens;
      }
      session._copilotTextStartedThisTurn = false;
      // Track whether the turn produced ANY output (text, thinking, or a tool
      // call). A turn that ends with no activity and zero cost is an empty
      // completion - the provider session is wedged or rate-limited and the
      // user would otherwise see a silent blank. See the result handler below.
      session._turnSawActivity = false;
      // Reset the captured stop_reason; set from message_delta below and read in
      // the result handler to flag a max_tokens truncation.
      session._lastStopReason = null;

    } else if (parsed.yokeType === "message_delta") {
      if (parsed.stopReason) session._lastStopReason = parsed.stopReason;

    } else if (parsed.yokeType === "tool_start" || parsed.yokeType === "thinking_start" || parsed.yokeType === "text_start") {
      var idx = parsed.blockId;
      session._turnSawActivity = true;

      if (parsed.yokeType === "tool_start") {
        session.blocks[idx] = { type: "tool_use", id: parsed.toolId, name: parsed.toolName, inputJson: "" };
        sendAndRecord(session, { type: "tool_start", id: parsed.toolId, name: parsed.toolName });
      } else if (parsed.yokeType === "thinking_start") {
        session.blocks[idx] = { type: "thinking", thinkingText: "", startTime: Date.now() };
        sendAndRecord(session, { type: "thinking_start" });
      } else if (parsed.yokeType === "text_start") {
        if (session.vendor === "github-copilot" && session._copilotTextStartedThisTurn) {
          sendAndRecord(session, { type: "delta", text: "\n\n" });
        }
        session._copilotTextStartedThisTurn = true;
        session.blocks[idx] = { type: "text" };
      }

    } else if (parsed.yokeType === "text_delta" || parsed.yokeType === "tool_input_delta" || parsed.yokeType === "thinking_delta") {
      var idx = parsed.blockId;
      session._turnSawActivity = true;

      if (parsed.yokeType === "text_delta" && typeof parsed.text === "string") {
        session.streamedText = true;
        if (session.responsePreview.length < 200) {
          session.responsePreview += parsed.text;
        }
        if (session.taskLauncher && session.taskLauncher.completion && session.taskLauncher.completion.marker) {
          session._taskWorkflowResponseText = (session._taskWorkflowResponseText || "") + parsed.text;
        }
        // Accumulate text for mate DM response
        if (typeof session._mateDmResponseText === "string") {
          session._mateDmResponseText += parsed.text;
        }
        sendAndRecord(session, { type: "delta", text: parsed.text });
      } else if (parsed.yokeType === "tool_input_delta" && session.blocks[idx]) {
        session.blocks[idx].inputJson += parsed.partialJson;
      } else if (parsed.yokeType === "thinking_delta" && session.blocks[idx]) {
        session.blocks[idx].thinkingText += parsed.text;
        sendAndRecord(session, { type: "thinking_delta", text: parsed.text });
      }

    } else if (parsed.yokeType === "tool_executing") {
      sendAndRecord(session, {
        type: "tool_executing",
        id: parsed.toolId,
        name: parsed.toolName,
        input: parsed.input || {},
      });
      try { sessionWorktree.noteTool(cwd, session, parsed.toolName, parsed.input || {}); } catch (e) {}

    } else if (parsed.yokeType === "tool_result") {
      sendAndRecord(session, {
        type: "tool_result",
        id: parsed.toolId,
        content: parsed.content || "",
        is_error: !!parsed.isError,
      });

    } else if (parsed.yokeType === "plan_updated") {
      var todos = Array.isArray(parsed.plan) ? parsed.plan.map(function(step, idx) {
        var todo = {
          id: String(idx + 1),
          content: step.step || "",
          status: step.status || "pending",
        };
        if (todo.status === "in_progress" && parsed.explanation) {
          todo.activeForm = parsed.explanation;
        }
        return todo;
      }) : [];
      sendAndRecord(session, {
        type: "tool_executing",
        id: parsed.turnId || "codex-plan",
        name: "TodoWrite",
        input: {
          todos: todos,
          meta: {
            variant: "plan",
            title: parsed.title || "Plan",
          },
        },
      });

    } else if (parsed.yokeType === "plan_content") {
      sendAndRecord(session, {
        type: "plan_content",
        content: parsed.content || "",
      });

    } else if (parsed.yokeType === "block_stop") {
      var idx = parsed.blockId;
      var block = session.blocks[idx];

      if (block && block.type === "tool_use") {
        var input = {};
        try { input = JSON.parse(block.inputJson); } catch (e) {}
        sendAndRecord(session, { type: "tool_executing", id: block.id, name: block.name, input: input });
        try { sessionWorktree.noteTool(cwd, session, block.name, input); } catch (e) {}

        // Track active Task tools for sub-agent done detection
        if (block.name === "Task") {
          if (!session.activeTaskToolIds) session.activeTaskToolIds = {};
          session.activeTaskToolIds[block.id] = true;
        }

        if (pushModule && block.name === "AskUserQuestion" && input.questions) {
          var q = input.questions[0];
          pushModule.sendPush({
            type: "ask_user",
            slug: slug,
            title: (mateDisplayName || "Claude") + " has a question",
            body: q ? q.question : "Waiting for your response",
            tag: "claude-ask",
          });
        }
      } else if (block && block.type === "thinking") {
        var duration = block.startTime ? (Date.now() - block.startTime) / 1000 : 0;
        sendAndRecord(session, { type: "thinking_stop", duration: duration });
      }

      delete session.blocks[idx];

    } else if (parsed.yokeType === "subagent_message") {
      // Sub-agent messages: extract tool_use blocks for activity display
      processSubagentMessage(session, parsed);

    } else if (parsed.yokeType === "message") {
      var content = parsed.content;

      // Fallback: if assistant text wasn't streamed via deltas, send it now
      if (parsed.messageRole === "assistant" && !session.streamedText && Array.isArray(content)) {
        var assistantText = content
          .filter(function(c) { return c.type === "text"; })
          .map(function(c) { return c.text; })
          .join("");
        if (assistantText) {
          session._turnSawActivity = true;
          if (session.responsePreview.length < 200) {
            session.responsePreview += assistantText;
          }
          if (session.taskLauncher && session.taskLauncher.completion && session.taskLauncher.completion.marker) {
            session._taskWorkflowResponseText = (session._taskWorkflowResponseText || "") + assistantText;
          }
          sendAndRecord(session, { type: "delta", text: assistantText });
        }
      }

      // Check for local slash command output in user messages
      if (parsed.messageRole === "user") {
        var fullText = "";
        if (typeof content === "string") {
          fullText = content;
        } else if (Array.isArray(content)) {
          fullText = content
            .filter(function(c) { return c.type === "text"; })
            .map(function(c) { return c.text; })
            .join("\n");
        }
        if (fullText.indexOf("local-command-stdout") !== -1) {
          var m = fullText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          if (m) {
            sendAndRecord(session, { type: "slash_command_result", text: m[1].trim() });
          }
        }
      }

      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var block = content[i];
          if (block.type === "tool_result" && !session.sentToolResults[block.tool_use_id]) {
            // Clear active Task tool when its result arrives
            if (session.activeTaskToolIds && session.activeTaskToolIds[block.tool_use_id]) {
              sendAndRecord(session, {
                type: "subagent_done",
                parentToolId: block.tool_use_id,
              });
              delete session.activeTaskToolIds[block.tool_use_id];
            }
            var resultText = "";
            var resultImages = [];
            if (typeof block.content === "string") {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .filter(function(c) { return c.type === "text"; })
                .map(function(c) { return c.text; })
                .join("\n");
              for (var ri = 0; ri < block.content.length; ri++) {
                var rc = block.content[ri];
                if (rc.type === "image" && rc.source) {
                  resultImages.push({
                    mediaType: rc.source.media_type,
                    data: rc.source.data,
                  });
                }
              }
            }
            session.sentToolResults[block.tool_use_id] = true;
            var toolResultMsg = {
              type: "tool_result",
              id: block.tool_use_id,
              content: resultText,
              is_error: block.is_error || false,
            };
            if (resultImages.length > 0) toolResultMsg.images = resultImages;
            sendAndRecord(session, toolResultMsg);
          }
        }
      }

    } else if (parsed.yokeType === "model_verified") {
      applyModelVerification(session, parsed);
    } else if (parsed.yokeType === "result") {
      if (parsed.verifiedModel) {
        applyModelVerification(session, {
          model: parsed.verifiedModel,
          requestedModel: parsed.requestedModel || null,
          source: parsed.modelVerificationSource || "response",
        });
      }
      session.blocks = {};
      session.sentToolResults = {};
      session.pendingPermissions = {};
      session.pendingElicitations = {};
      // Record ask_user_answered for any leftover pending questions so replay pairs correctly.
      // EXCEPTION: "mcp" mode entries are stateless - the tool returned immediately and the
      // turn is expected to end while the card is still awaiting the user's answer. Those
      // entries must survive across turns so the eventual ask_user_response can inject the
      // answer as the next user message. Only blocking modes (Claude canUseTool) get closed.
      var leftoverAskIds = Object.keys(session.pendingAskUser);
      var keptAskUser = {};
      for (var lai = 0; lai < leftoverAskIds.length; lai++) {
        var lid = leftoverAskIds[lai];
        var lentry = session.pendingAskUser[lid];
        if (lentry && lentry.mode === "mcp") {
          keptAskUser[lid] = lentry;
          continue;
        }
        sendAndRecord(session, { type: "ask_user_answered", toolId: lid });
      }
      session.pendingAskUser = keptAskUser;
      session.activeTaskToolIds = {};
      session.taskIdMap = {};
      // Only clear rateLimitResetsAt on genuine success (non-zero cost).
      // When rate-limited, the SDK sends result with zero cost right after
      // rate_limit_event; clearing here would prevent auto-continue scheduling.
      if (parsed.cost && parsed.cost > 0) {
        session.rateLimitResetsAt = null;
        session.streamEndedAutoRetryQueued = false;
        // Genuine success - re-arm the one-shot transient-stream-error retry
        // guard so a future independent drop can also retry once.
        session._transientRetryUsed = false;
      }
      console.log("[sdk-bridge] result handler: session " + session.localId + " cost=" + parsed.cost + " rateLimitResetsAt=" + session.rateLimitResetsAt);

      // Handle SDK execution errors: show the error to the user instead of
      // silently swallowing it. These have subtype "error_during_execution".
      if (parsed.subtype === "error_during_execution") {
        var execErrors = parsed.errors || [];
        var execError = execErrors.length > 0
          ? execErrors.join("; ")
          : "Unknown SDK error";
        execError = normalizeExecutionError(session, execError);
        if (parsed.terminalReason) execError += " (reason: " + parsed.terminalReason + ")";
        console.error("[sdk-bridge] Execution error for session " + session.localId + ": " + execError);
        session.isProcessing = false;
        onProcessingChanged();
        // Transient network/stream failure surfaced as a result error — recover
        // automatically instead of dead-ending (one shot, budget-capped).
        if (maybeAutoResumeTransientApiError(session, execError, false)) {
          sendAndRecord(session, { type: "done", code: 0 });
          sm.broadcastSessionList();
          return;
        }
        sendAndRecord(session, { type: "error", text: providerDisplayName(session) + " error: " + execError });
        sendAndRecord(session, { type: "done", code: 1 });
        sm.broadcastSessionList();
        return;
      }

      session.isProcessing = false;
      onProcessingChanged();
      // Detect "Not logged in" scenario early for the check below
      var previewTrimmed = (session.responsePreview || "").trim();
      var isZeroCost = !parsed.cost || parsed.cost === 0;
      var isLoginPrompt = isZeroCost && previewTrimmed.length < 100
        && /not logged in/i.test(previewTrimmed) && /\/login/i.test(previewTrimmed);
      // Fetch rich context usage breakdown (fire-and-forget, non-blocking)
      if (session.queryInstance && typeof session.queryInstance.getContextUsage === "function") {
        session.queryInstance.getContextUsage().then(function(ctxUsage) {
          session.lastContextUsage = ctxUsage;
          sendToSession(session, { type: "context_usage", data: ctxUsage });
        }).catch(function(e) {
          console.error("[sdk-bridge] getContextUsage failed (non-fatal):", e.message || e);
        });
      }
      var lastStreamInput = session.lastStreamInputTokens || parsed.lastStreamInputTokens || null;
      session.lastStreamInputTokens = null;
      sendAndRecord(session, {
        type: "result",
        cost: parsed.cost,
        duration: parsed.duration,
        usage: parsed.usage || null,
        modelUsage: parsed.modelUsage || null,
        sessionId: parsed.sessionId,
        requestedModel: parsed.requestedModel || null,
        verifiedModel: parsed.verifiedModel || null,
        modelVerificationSource: parsed.modelVerificationSource || null,
        lastStreamInputTokens: lastStreamInput,
        truncatedReason: parsed.truncatedReason
          || (session._lastStopReason === "max_tokens" ? "the response hit the output token limit" : null),
      });
      if (parsed.fastModeState) {
        sendAndRecord(session, { type: "fast_mode_state", state: parsed.fastModeState });
      }
      // Detect "Not logged in / Please run /login" from SDK.
      // This is a short canned response with zero cost, not actual AI output.
      if (isLoginPrompt) {
        var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
        var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
        var canAutoLogin = !usersModule.isMultiUser()
          || !!authLinuxUser
          || (authUser && authUser.role === "admin");
        var authTitle = session.vendor === "codex" ? "Codex is not logged in." : "Claude Code is not logged in.";
        var loginCommand = session.vendor === "codex"
          ? "codex login --device-auth"
          : "claude login";
        var _nmLogin = getNotificationsModule();
        var authMsg = {
          type: "auth_required",
          text: authTitle,
          vendor: session.vendor || "claude",
          loginCommand: loginCommand,
          linuxUser: authLinuxUser,
          canAutoLogin: canAutoLogin,
        };
        sendAndRecord(session, authMsg);
        if (_nmLogin) {
          _nmLogin.notify("auth_required", {
            title: authTitle,
            body: "Open a terminal, then click the URL and follow the instructions.",
            slug: slug,
            sessionId: session.localId,
            ownerId: session.ownerId || null,
            vendor: session.vendor || "claude",
            loginCommand: loginCommand,
            linuxUser: authLinuxUser,
            canAutoLogin: canAutoLogin,
          });
        }
        // Reset CLI session so next query starts fresh with new auth
        session.cliSessionId = null;
      }
      // Proactive context-window guard: warn ONCE as the thread approaches the
      // model context window, before it fills and turns start coming back empty
      // (a full window makes codex app-server ack turns but return nothing).
      var _ctxWindow = parsed.contextWindow ||
        (parsed.modelUsage && parsed.verifiedModel && parsed.modelUsage[parsed.verifiedModel] && parsed.modelUsage[parsed.verifiedModel].contextWindow) || null;
      var _ctxUsed = parsed.contextUsedTokens || null;
      if (_ctxWindow && _ctxUsed) {
        var _occ = _ctxUsed / _ctxWindow;
        if (_occ > 1.5) {
          // True context occupancy is bounded by the window. A wildly-over
          // reading means we read a cumulative token field, not live occupancy
          // - skip rather than show a nonsensical "270%" warning.
          console.warn("[sdk-bridge] implausible context occupancy for session " + session.localId +
            " (" + _ctxUsed + "/" + _ctxWindow + "); skipping context warning");
        } else if (_occ >= 0.9 && !session._contextLimitWarned) {
          session._contextLimitWarned = true;
          var _pct = Math.min(100, Math.round(_occ * 100));
          sendAndRecord(session, {
            type: "info",
            text: providerDisplayName(session) + " is near its context window (" +
              _pct + "% - " + _ctxUsed + " of " + _ctxWindow + " tokens). Responses may start coming back empty; consider forking or starting a fresh compacted continuation.",
          });
        } else if (_occ < 0.7 && session._contextLimitWarned) {
          // Re-arm after a compaction/fork drops usage well below the threshold.
          session._contextLimitWarned = false;
        }
      }

      // Empty-turn guard: the turn completed with no text, no thinking, no tool
      // call, and zero cost. This is what a wedged or rate-limited provider
      // session looks like (e.g. a resumed Codex thread that acks the turn but
      // never reaches the model). Surface it instead of showing a silent blank.
      if (!session._turnSawActivity && isZeroCost && !isLoginPrompt) {
        console.warn("[sdk-bridge] empty turn for session " + session.localId +
          " (vendor=" + (session.vendor || "?") + "): no output, zero cost");
        var canCompactEmptyTurn = session.vendor === "codex" &&
          typeof opts.compactAndContinue === "function" &&
          !session._emptyTurnCompactionQueued &&
          !session.compactedFromLocalId &&
          !session.compactedIntoLocalId &&
          (session.compactionDepth || 0) < 1;
        if (canCompactEmptyTurn) {
          session._emptyTurnCompactionQueued = true;
          sendAndRecord(session, {
            type: "info",
            text: providerDisplayName(session) + " returned an empty response with no token usage. Clay is compacting the conversation into a fresh session and retrying the latest message.",
          });
          try {
            opts.compactAndContinue(session, { reason: "empty_turn" });
          } catch (compactErr) {
            console.error("[sdk-bridge] empty-turn compaction failed for session " + session.localId + ": " + (compactErr.message || compactErr));
            sendAndRecord(session, {
              type: "error",
              text: "Clay could not compact this session automatically. Start a fresh session and paste the relevant context.",
            });
          }
        } else {
          sendAndRecord(session, {
            type: "error",
            text: providerDisplayName(session) + " returned an empty response with no output and no token usage. The provider session may be wedged or out of context. Start a fresh or compacted continuation.",
          });
        }
      }
      sendAndRecord(session, { type: "done", code: 0 });
      var _donePreviewText = (session.responsePreview || "").replace(/\s+/g, " ").trim();
      if (_donePreviewText.length > 140) _donePreviewText = _donePreviewText.substring(0, 140) + "...";
      var _doneTitle = mateDisplayName ? (mateDisplayName + " responded") : (session.title || "Claude");

      if (pushModule && !session.suppressDonePush) {
        pushModule.sendPush({
          type: "done",
          slug: slug,
          title: _doneTitle,
          body: _donePreviewText || "Response ready",
          tag: "claude-done",
        });
      }

      var _nm = getNotificationsModule();
      if (_nm && !session.loop && !session.suppressDonePush) {
        _nm.notify("response_done", {
          title: _doneTitle,
          preview: _donePreviewText,
          slug: slug,
          sessionId: session.localId,
          mateId: getMateIdForNotification(),
          ownerId: session.ownerId || null,
        });
      }
      // Reset for next turn in the same query
      session.lastActivityAt = Date.now();
      session.turnCount = (session.turnCount || 0) + 1;
      var donePreview = session.responsePreview || "";
      var doneFullText = session._taskWorkflowResponseText || donePreview;
      session.responsePreview = "";
      session._taskWorkflowResponseText = "";
      session.streamedText = false;
      // If the turn's only output was a transient "API Error:" (e.g. the SDK's
      // "socket connection was closed unexpectedly") delivered in-band, auto-
      // resume instead of dead-ending and waiting for the user to type continue.
      maybeAutoResumeTransientApiError(session, donePreview, true);
      sm.broadcastSessionList();

      // Auto-generate title after N turns (skip if loop or already auto-generated)
      if (session.turnCount === AUTO_TITLE_TURN_THRESHOLD
          && !session.titleAutoGenerated
          && !session.titleManuallySet
          && !session.loop
          && onAutoTitle) {
        try { onAutoTitle(session); } catch (e) {
          console.error("[auto-title] onAutoTitle threw:", e.message || e);
        }
      }

      if (onTurnDone) {
        try { onTurnDone(session, donePreview, doneFullText); } catch (e) {}
      }

    } else if (parsed.yokeType === "status") {
      if (parsed.status === "compacting") {
        sendAndRecord(session, { type: "compacting", active: true });
      } else if (session.compacting) {
        sendAndRecord(session, { type: "compacting", active: false });
      }
      session.compacting = parsed.status === "compacting";

    } else if (parsed.yokeType === "task_started") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        if (!session.taskIdMap) session.taskIdMap = {};
        session.taskIdMap[parentId] = parsed.taskId;
        sendAndRecord(session, {
          type: "task_started",
          parentToolId: parentId,
          taskId: parsed.taskId,
          description: parsed.description || "",
        });
      }

    } else if (parsed.yokeType === "task_progress") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        sendAndRecord(session, {
          type: "task_progress",
          parentToolId: parentId,
          taskId: parsed.taskId,
          usage: parsed.usage || null,
          lastToolName: parsed.lastToolName || null,
          description: parsed.description || "",
          summary: parsed.summary || null,
        });
      }

    } else if (parsed.yokeType === "task_updated") {
      // Live task state patches (status, description, error, backgrounded)
      var taskId = parsed.task_id;
      var patch = parsed.patch || {};
      var parentId = null;
      if (session.taskIdMap) {
        for (var k in session.taskIdMap) {
          if (session.taskIdMap[k] === taskId) { parentId = k; break; }
        }
      }
      if (parentId) {
        sendAndRecord(session, {
          type: "task_updated",
          parentToolId: parentId,
          taskId: taskId,
          patch: patch,
        });
      }

    } else if (parsed.yokeType === "tool_progress") {
      // Sub-agent tool_progress: forward as activity update
      var parentId = parsed.parentToolId;
      if (parentId) {
        sendAndRecord(session, {
          type: "subagent_activity",
          parentToolId: parentId,
          text: parsed.text || "",
        });
      }

    } else if (parsed.yokeType === "task_notification") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        sendAndRecord(session, {
          type: "subagent_done",
          parentToolId: parentId,
          status: parsed.status || "completed",
          summary: parsed.summary || "",
          usage: parsed.usage || null,
        });
      }
      if (session.taskIdMap) {
        for (var k in session.taskIdMap) {
          if (session.taskIdMap[k] === parsed.taskId) {
            delete session.taskIdMap[k];
            break;
          }
        }
      }

    } else if (parsed.yokeType === "rate_limit") {
      var info = parsed.rateLimitInfo;
      console.log("[sdk-bridge] rate_limit_event for session " + session.localId + ": status=" + info.status + " resetsAt=" + info.resetsAt + " isUsingOverage=" + info.isUsingOverage + " isProcessing=" + session.isProcessing);

      // Broadcast reset time for top-bar usage link
      if (info.rateLimitType && info.resetsAt) {
        send({
          type: "rate_limit_usage",
          vendor: session.vendor || "claude",
          rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt * 1000,
          status: info.status,
          utilization: typeof info.utilization === "number" ? info.utilization : null,
        });
      }

      // Warning/rejection handling (existing behavior)
      if (info.status === "allowed_warning" || info.status === "rejected") {
        sendAndRecord(session, {
          type: "rate_limit",
          status: info.status,
          resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
          rateLimitType: info.rateLimitType || null,
          utilization: info.utilization || null,
          isUsingOverage: info.isUsingOverage || false,
        });
        // Track rejection for auto-continue / scheduled message support
        if (info.status === "rejected" && info.resetsAt) {
          session.rateLimitResetsAt = info.resetsAt * 1000;

          // Schedule auto-continue immediately on rejection (don't wait for
          // query completion which has timing issues with worker/non-worker paths).
          if (!session.scheduledMessage && !session.destroying) {
            var acEnabled = session.onQueryComplete ||
              (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
            console.log("[sdk-bridge] rate_limit rejected: acEnabled=" + acEnabled + " overage=" + !!info.isUsingOverage + " session=" + session.localId);
            if (acEnabled) {
              session.rateLimitAutoContinuePending = true;
              if (info.isUsingOverage) {
                // Extra usage available: send continue immediately (5s delay for query to finish)
                console.log("[sdk-bridge] Overage available, sending immediate continue for session " + session.localId);
                session.rateLimitResetsAt = null;
                if (typeof opts.scheduleMessage === "function") {
                  opts.scheduleMessage(session, "continue", Date.now());
                }
              } else {
                // No overage: schedule after rate limit resets
                var acResetsAt = session.rateLimitResetsAt;
                session.rateLimitResetsAt = null;
                console.log("[sdk-bridge] Scheduling auto-continue on rate limit rejection for session " + session.localId);
                if (typeof opts.scheduleMessage === "function") {
                  opts.scheduleMessage(session, "continue", acResetsAt);
                }
              }
            }
          }
        }
      }

    } else if (parsed.yokeType === "prompt_suggestion") {
      sendAndRecord(session, {
        type: "prompt_suggestion",
        suggestion: parsed.suggestion || "",
      });

    } else if (parsed.yokeType === "notification") {
      var notifText = parsed.text || "";
      var notifPriority = parsed.priority || "low";
      if (notifText) {
        sendAndRecord(session, {
          type: "sdk_notification",
          key: parsed.key || "",
          text: notifText,
          priority: notifPriority,
          color: parsed.color || null,
          timeoutMs: parsed.timeout_ms || null,
        });
      }

    } else if (parsed.yokeType === "api_retry") {
      // Transient retry notification, show in UI but don't persist in history
      var retryText = parsed.message || parsed.error || "Retrying API request...";
      sendToSession(session, { type: "system_info", text: retryText });

    } else if (parsed.yokeType === "system") {
      // Catch-all for unhandled system subtypes (e.g. hook-block errors).
      // Extract any error text and surface it in the UI.
      var sysText = parsed.error || parsed.message || parsed.text || "";
      if (!sysText && Array.isArray(parsed.content)) {
        sysText = parsed.content
          .filter(function(c) { return c.type === "text"; })
          .map(function(c) { return c.text; })
          .join("\n");
      }
      if (sysText) {
        console.log("[sdk-bridge] Unhandled system message (subtype=" + (parsed.subtype || "none") + "): " + sysText.substring(0, 200));
        sendAndRecord(session, { type: "error", text: sysText });
      }
    }
  }

  return {
    processSDKMessage: processSDKMessage,
    sendAndRecord: sendAndRecord,
    sendToSession: sendToSession,
    processSubagentMessage: processSubagentMessage,
    toolActivityTextForSubagent: toolActivityTextForSubagent,
  };
}

module.exports = { attachMessageProcessor: attachMessageProcessor };
