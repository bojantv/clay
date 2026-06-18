var path = require("path");
var fs = require("fs");
var { meaningfulTextTitle } = require("./text-title");

/**
 * Attach user-message handler and remaining small handlers
 * (sticky notes, terminals, context sources, browser extension,
 *  scheduled tasks gate, loop delegation, schedule_message,
 *  and the main "message" dispatch) to a project context.
 *
 * ctx fields:
 *   cwd, slug, isMate, osUsers,
 *   sm, sdk, nm, tm,
 *   send, sendTo, sendToSession, sendToSessionOthers,
 *   clients, opts,
 *   usersModule, matesModule,
 *   getSessionForWs, getLinuxUserForSession, ensureProjectAccessForSession, getOsUserInfoForWs,
 *   hydrateImageRefs, saveImageFile, imagesDir,
 *   onProcessingChanged, onSessionDone,
 *   onUserMessageDispatched,
 *   _loop              - { handleLoopMessage: fn(ws, msg) }
 *   browserState       - { _browserTabList, _extensionWs, pendingExtensionRequests } (mutable refs)
 *   sendExtensionCommandAny, requestTabContext,
 *   startFileWatch, stopFileWatch,
 *   scheduleMessage, cancelScheduledMessage,
 *   loadContextSources, saveContextSources,
 *   digestDmTurn, gateMemory,
 *   adapter            - YOKE adapter instance
 */
function attachUserMessage(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var isMate = ctx.isMate;
  var osUsers = ctx.osUsers;

  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var nm = ctx.nm;
  var tm = ctx.tm;

  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;

  var clients = ctx.clients;
  var opts = ctx.opts;

  var usersModule = ctx.usersModule;
  var matesModule = ctx.matesModule;

  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;

  var hydrateImageRefs = ctx.hydrateImageRefs;
  var saveImageFile = ctx.saveImageFile;
  var imagesDir = ctx.imagesDir;

  var onProcessingChanged = ctx.onProcessingChanged;
  var onUserMessageDispatched = ctx.onUserMessageDispatched || function () {};

  var _loop = ctx._loop;
  var browserState = ctx.browserState;

  var sendExtensionCommandAny = ctx.sendExtensionCommandAny;
  var requestTabContext = ctx.requestTabContext;

  var scheduleMessage = ctx.scheduleMessage;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;

  var loadContextSources = ctx.loadContextSources;
  var saveContextSources = ctx.saveContextSources;

  var adapter = ctx.adapter;
  var _email = ctx._email;

  // --------------- Sticky notes ---------------

  function shouldQueueDuringProcessing(session) {
    return !!(session && session.isProcessing);
  }

  function makeQueueId() {
    return "q-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function findQueuedHistoryMessage(session, queueId) {
    if (!session || !queueId || !session.history) return null;
    for (var i = session.history.length - 1; i >= 0; i--) {
      var item = session.history[i];
      if (item && item.type === "user_message" && item.queueId === queueId) {
        return item;
      }
    }
    return null;
  }

  function markQueuedHistoryAsSteered(session, queueId) {
    var item = findQueuedHistoryMessage(session, queueId);
    if (!item) return null;
    delete item.queuedDuringProcessing;
    delete item.queuedPending;
    item.steerDuringProcessing = true;
    item.steerPending = true;
    item._ts = Date.now();
    sm.saveSessionFile(session);
    return item;
  }

  function markQueuedHistoryAsDispatched(session, queueId) {
    var item = findQueuedHistoryMessage(session, queueId);
    if (!item) return null;
    delete item.queuedDuringProcessing;
    delete item.queuedPending;
    delete item.steerPending;
    item._ts = Date.now();
    sm.saveSessionFile(session);
    return item;
  }

  function removeQueuedHistoryMessage(session, queueId) {
    if (!session || !queueId || !session.history) return false;
    var removed = false;
    var nextHistory = [];
    for (var i = 0; i < session.history.length; i++) {
      var item = session.history[i];
      if (item && item.type === "user_message" && item.queueId === queueId) {
        removed = true;
        continue;
      }
      nextHistory.push(item);
    }
    if (removed) {
      session.history = nextHistory;
      sm.saveSessionFile(session);
    }
    return removed;
  }

  function sendQueuedUserMessagesState(session) {
    if (!session) return;
    sendToSession(session.localId, {
      type: "queued_user_messages_state",
      queueingDisabled: !!session.queueingDisabled,
      queuedUserMessages: sm.queuedUserMessagesForClient ? sm.queuedUserMessagesForClient(session) : [],
    });
  }

  function recentTurnHadApiError(session) {
    if (!session || !Array.isArray(session.history)) return false;
    var sawApiError = false;
    var skippedCurrentUserMessage = false;
    for (var i = session.history.length - 1; i >= 0; i--) {
      var item = session.history[i] || {};
      if (item.type === "user_message") {
        if (!skippedCurrentUserMessage) {
          skippedCurrentUserMessage = true;
          continue;
        }
        return sawApiError;
      }
      var text = item.text || item.content || "";
      if ((item.type === "delta" || item.type === "error") && /^API Error:/i.test(String(text).trim())) {
        sawApiError = true;
      } else if (item.type === "error" && / API error: API Error:/i.test(String(text))) {
        sawApiError = true;
      }
    }
    return sawApiError;
  }

  function shouldRetryAfterApiError(session, userText) {
    var text = String(userText || "").trim().toLowerCase();
    if (!text) return false;
    if (text !== "continue" && text !== "continue." && text !== "keep going" && text !== "go on") return false;
    return recentTurnHadApiError(session);
  }

  function getSessionForMessage(ws, msg) {
    var requestedId = msg && msg.sessionId;
    if (typeof requestedId === "string" && requestedId.trim()) {
      requestedId = Number(requestedId);
    }
    if (typeof requestedId === "number" && isFinite(requestedId)) {
      var requestedSession = sm.sessions.get(requestedId);
      if (requestedSession) {
        if (requestedSession.hidden) return null;
        if (usersModule.isMultiUser()) {
          if (!ws._clayUser) return null;
          if (!usersModule.canAccessSession(ws._clayUser.id, requestedSession, { visibility: "public" })) return null;
        } else if (requestedSession.ownerId) {
          return null;
        }
        ws._clayActiveSession = requestedSession.localId;
        return requestedSession;
      }
    }
    return getSessionForWs(ws);
  }

  function queuePreparedMessage(session, finalText, images, queueId, displayText, imageCount, clientMessageId, pastes, options) {
    options = options || {};
    if (!session.pendingUserMessageQueue) session.pendingUserMessageQueue = [];
    if (!queueId) queueId = makeQueueId();
    var item = {
      queueId: queueId,
      text: finalText || "",
      images: images || null,
      pastes: pastes || null,
      displayText: displayText || "",
      imageCount: imageCount || 0,
      clientMessageId: clientMessageId || null,
      hidden: !!options.hidden,
    };
    if (options.front) {
      session.pendingUserMessageQueue.unshift(item);
    } else {
      session.pendingUserMessageQueue.push(item);
    }
    if (!options.silent) {
      sendToSession(session.localId, {
        type: "queued_user_message",
        queueId: queueId,
        text: displayText || "",
        imageCount: imageCount || 0,
        images: images || null,
        pastes: pastes || null,
        clientMessageId: clientMessageId || null,
      });
    }
    sendQueuedUserMessagesState(session);
    sm.broadcastSessionList();
  }

  function dispatchPreparedToSdk(session, finalText, images, steer, queueId, displayText, imageCount, clientMessageId, pastes) {
    if (!steer && shouldQueueDuringProcessing(session)) {
      queuePreparedMessage(session, finalText, images, queueId, displayText, imageCount, clientMessageId, pastes);
      return;
    }
    if (steer && session.isProcessing) {
      if (!queueId) queueId = makeQueueId();
      queuePreparedMessage(session, finalText, images, queueId, displayText, imageCount, clientMessageId, pastes, { front: true });
      session.steerInterruptRequested = true;
      session.taskStopRequested = true;
      sm.saveSessionFile(session);
      if (session.abortController) session.abortController.abort();
      return;
    }
    onUserMessageDispatched(session, displayText || finalText || "");
    if (!session.isProcessing) {
      session.isProcessing = true;
      onProcessingChanged();
      session.sentToolResults = {};
      sendToSession(session.localId, { type: "status", status: "processing" });
      if (!session.queryInstance && (!session.worker || session.messageQueue !== "worker")) {
        session._queryStartTs = Date.now();
        console.log("[PERF] project.js: startQuery called, localId=" + session.localId + " t=0ms");
        sdk.startQuery(session, finalText, images, ensureProjectAccessForSession(session));
      } else {
        sdk.pushMessage(session, finalText, images);
      }
    } else {
      sdk.pushMessage(session, finalText, images);
    }
    sm.broadcastSessionList();
  }

  function flushQueuedUserMessage(session) {
    if (!session || session.isProcessing) return;
    if (!session.pendingUserMessageQueue || session.pendingUserMessageQueue.length === 0) {
      sendQueuedUserMessagesState(session);
      return;
    }
    var next = session.pendingUserMessageQueue.shift();
    sendToSession(session.localId, {
      type: "queued_user_message_removed",
      queueId: next.queueId,
    });
    var queuedHistoryItem = markQueuedHistoryAsDispatched(session, next.queueId);
    sendQueuedUserMessagesState(session);
    if (queuedHistoryItem && !queuedHistoryItem.steerDuringProcessing && !next.hidden) {
      sendToSession(session.localId, hydrateImageRefs(queuedHistoryItem));
    }
    dispatchPreparedToSdk(session, next.text, next.images, false, next.queueId, next.displayText, next.imageCount, next.clientMessageId, next.pastes);
  }

  function syncNotesKnowledge() {
    if (!isMate) return;
    try {
      var knDir = path.join(cwd, "knowledge");
      var knFile = path.join(knDir, "sticky-notes.md");
      var text = nm.getActiveNotesText();
      if (text) {
        fs.mkdirSync(knDir, { recursive: true });
        fs.writeFileSync(knFile, text);
      } else {
        try { fs.unlinkSync(knFile); } catch (e) {}
      }
    } catch (e) {
      console.error("[project] Failed to sync sticky-notes.md:", e.message);
    }
  }

  // --------------- Main handler ---------------

  function handleUserMessage(ws, msg) {
    // --- Sticky notes ---
    if (msg.type === "note_create") {
      var note = nm.create(msg);
      if (note) {
        send({ type: "note_created", note: note });
        syncNotesKnowledge();
      }
      return true;
    }

    if (msg.type === "note_update") {
      if (!msg.id) return true;
      var updated = nm.update(msg.id, msg);
      if (updated) {
        send({ type: "note_updated", note: updated });
        if (msg.text !== undefined || msg.hidden !== undefined) syncNotesKnowledge();
      }
      return true;
    }

    if (msg.type === "note_delete") {
      if (!msg.id) return true;
      if (nm.remove(msg.id)) {
        send({ type: "note_deleted", id: msg.id });
        syncNotesKnowledge();
      }
      return true;
    }

    if (msg.type === "note_list_request") {
      sendTo(ws, { type: "notes_list", notes: nm.list() });
      return true;
    }

    if (msg.type === "note_bring_front") {
      if (!msg.id) return true;
      var front = nm.bringToFront(msg.id);
      if (front) send({ type: "note_updated", note: front });
      return true;
    }

    // --- Web terminal ---
    if (msg.type === "term_create") {
      if (ws._clayUser) {
        var termPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!termPerms.terminal) {
          sendTo(ws, { type: "term_error", error: "Terminal access is not permitted" });
          return true;
        }
      }
      var t = tm.create(msg.cols || 80, msg.rows || 24, getOsUserInfoForWs(ws), ws);
      if (!t) {
        sendTo(ws, { type: "term_error", error: "Cannot create terminal (node-pty not available or limit reached)" });
        return true;
      }
      tm.attach(t.id, ws);
      send({ type: "term_list", terminals: tm.list() });
      sendTo(ws, { type: "term_created", id: t.id });
      return true;
    }

    if (msg.type === "term_attach") {
      if (msg.id) tm.attach(msg.id, ws);
      return true;
    }

    if (msg.type === "term_detach") {
      if (msg.id) tm.detach(msg.id, ws);
      return true;
    }

    if (msg.type === "term_input") {
      if (msg.id) tm.write(msg.id, msg.data);
      return true;
    }

    if (msg.type === "term_resize") {
      if (msg.id && msg.cols > 0 && msg.rows > 0) {
        tm.resize(msg.id, msg.cols, msg.rows, ws);
      }
      return true;
    }

    if (msg.type === "term_close") {
      if (msg.id) {
        tm.close(msg.id);
        send({ type: "term_list", terminals: tm.list() });
        // Remove closed terminal from context sources
        var _termSessionId = ws._clayActiveSession || null;
        var saved = loadContextSources(slug, _termSessionId);
        var termKey = "term:" + msg.id;
        var filtered = saved.filter(function(id) { return id !== termKey; });
        if (filtered.length !== saved.length) {
          saveContextSources(slug, _termSessionId, filtered);
          send({ type: "context_sources_state", active: filtered });
        }
      }
      return true;
    }

    if (msg.type === "term_rename") {
      if (msg.id && msg.title) {
        tm.rename(msg.id, msg.title);
        send({ type: "term_list", terminals: tm.list() });
      }
      return true;
    }

    // --- Context Sources ---
    if (msg.type === "context_sources_save") {
      var activeIds = msg.active || [];
      var _saveSessionId = ws._clayActiveSession || null;
      saveContextSources(slug, _saveSessionId, activeIds);
      return true;
    }

    // --- Browser Extension ---
    if (msg.type === "browser_tab_list") {
      browserState._extensionWs = ws; // Track which client has the extension
      if (msg.extensionId) browserState._extensionId = msg.extensionId;
      var tabs = msg.tabs || [];
      browserState._browserTabList = {};
      for (var bti = 0; bti < tabs.length; bti++) {
        browserState._browserTabList[tabs[bti].id] = tabs[bti];
      }
      return true;
    }

    if (msg.type === "extension_result") {
      var pending = browserState.pendingExtensionRequests[msg.requestId];
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(msg.result);
        delete browserState.pendingExtensionRequests[msg.requestId];
      }
      return true;
    }

    // --- Scheduled tasks permission gate ---
    if (msg.type === "loop_start" || msg.type === "loop_stop" || msg.type === "loop_registry_files" ||
        msg.type === "loop_registry_save_files" || msg.type === "loop_registry_list" ||
        msg.type === "loop_registry_update" || msg.type === "loop_registry_rename" ||
        msg.type === "loop_registry_remove" || msg.type === "loop_registry_convert" ||
        msg.type === "loop_registry_toggle" || msg.type === "loop_registry_rerun" ||
        msg.type === "schedule_create" || msg.type === "schedule_move") {
      if (ws._clayUser) {
        var schPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!schPerms.scheduledTasks) {
          sendTo(ws, { type: "error", text: "Scheduled tasks access is not permitted" });
          return true;
        }
      }
    }

    // --- Loop message delegation (project-loop.js) ---
    if (_loop.handleLoopMessage(ws, msg)) return true;

    // --- Schedule message for after rate limit resets ---
    if (msg.type === "schedule_message") {
      var schedSession = getSessionForMessage(ws, msg);
      if (!schedSession || !msg.text || !msg.resetsAt) return true;
      scheduleMessage(schedSession, msg.text, msg.resetsAt);
      return true;
    }

    if (msg.type === "cancel_scheduled_message") {
      var cancelSession = getSessionForMessage(ws, msg);
      if (!cancelSession) return true;
      cancelScheduledMessage(cancelSession);
      return true;
    }

    if (msg.type === "steer_queued_message") {
      var steerSession = getSessionForMessage(ws, msg);
      var steerQueueId = msg.queueId || "";
      if (!steerSession || !steerQueueId || !steerSession.pendingUserMessageQueue) return true;
      var steerIdx = -1;
      for (var sqi = 0; sqi < steerSession.pendingUserMessageQueue.length; sqi++) {
        if (steerSession.pendingUserMessageQueue[sqi].queueId === steerQueueId) {
          steerIdx = sqi;
          break;
        }
      }
      if (steerIdx === -1) return true;
      var steerItem = steerSession.pendingUserMessageQueue.splice(steerIdx, 1)[0];
      var steerHistoryItem = markQueuedHistoryAsSteered(steerSession, steerQueueId);
      sendToSession(steerSession.localId, {
        type: "queued_user_message_removed",
        queueId: steerQueueId,
      });
      sendQueuedUserMessagesState(steerSession);
      if (steerHistoryItem) {
        sendToSession(steerSession.localId, hydrateImageRefs(steerHistoryItem));
      }
      // Sequence matters: re-queue the steered message at the front and persist
      // it BEFORE aborting. The abort drives the stream to its turn-done path,
      // which (because steerInterruptRequested is set) flushes the queued
      // message into the next turn. Persisting first guarantees the hidden item
      // survives even if the abort resolves the turn immediately.
      queuePreparedMessage(steerSession, steerItem.text, steerItem.images, steerItem.queueId, steerItem.displayText, steerItem.imageCount, steerItem.clientMessageId, steerItem.pastes, { front: true, silent: true, hidden: true });
      steerSession.steerInterruptRequested = true;
      steerSession.taskStopRequested = true;
      sm.saveSessionFile(steerSession);
      if (steerSession.abortController) steerSession.abortController.abort();
      return true;
    }

    if (msg.type === "set_session_queueing") {
      var queueingSession = getSessionForMessage(ws, msg);
      if (!queueingSession) return true;
      // In-memory only (not persisted to the session file): the flag survives a
      // client refresh/reconnect but resets when the daemon restarts. There is
      // intentionally no re-enable from the UI; a restart is the reset path.
      queueingSession.queueingDisabled = !!msg.disabled;
      sendQueuedUserMessagesState(queueingSession);
      return true;
    }

    if (msg.type === "clear_queued_message") {
      var clearSession = getSessionForMessage(ws, msg);
      var clearQueueId = msg.queueId || "";
      if (!clearSession || !clearQueueId) return true;
      if (clearSession.pendingUserMessageQueue) {
        clearSession.pendingUserMessageQueue = clearSession.pendingUserMessageQueue.filter(function (item) {
          return item.queueId !== clearQueueId;
        });
      }
      removeQueuedHistoryMessage(clearSession, clearQueueId);
      sendToSession(clearSession.localId, {
        type: "queued_user_message_removed",
        queueId: clearQueueId,
      });
      sendQueuedUserMessagesState(clearSession);
      return true;
    }

    if (msg.type === "send_scheduled_now") {
      var nowSession = getSessionForMessage(ws, msg);
      if (!nowSession || !nowSession.scheduledMessage) return true;
      var schedText = nowSession.scheduledMessage.text;
      var schedDisplayText = nowSession.scheduledMessage.displayText || schedText;
      clearTimeout(nowSession.scheduledMessage.timer);
      nowSession.scheduledMessage = null;
      console.log("[project] Scheduled message sent immediately for session " + nowSession.localId);
      sm.sendAndRecord(nowSession, { type: "scheduled_message_sent" });
      var userMsg = { type: "user_message", text: schedDisplayText, _ts: Date.now() };
      nowSession.history.push(userMsg);
      sm.appendToSessionFile(nowSession, userMsg);
      sendToSession(nowSession.localId, userMsg);
      nowSession.isProcessing = true;
      onProcessingChanged();
      sendToSession(nowSession.localId, { type: "status", status: "processing" });
      sdk.startQuery(nowSession, schedText, null, ensureProjectAccessForSession(nowSession));
      sm.broadcastSessionList();
      return true;
    }

    if (msg.type !== "message") return false;
    if (!msg.text && (!msg.images || msg.images.length === 0) && (!msg.pastes || msg.pastes.length === 0)) return true;

    var session = getSessionForMessage(ws, msg);
    if (!session) return true;
    var wasProcessing = !!session.isProcessing;
    var steer = msg.steer === true;
    var queueId = wasProcessing ? makeQueueId() : null;
    var clientMessageId = typeof msg.clientMessageId === "string" ? msg.clientMessageId : null;
    var displayImageCount = msg.images ? msg.images.length : 0;

    // Bind vendor to session on first message (if not already set)
    if (!session.vendor && msg.vendor) {
      session.vendor = msg.vendor;
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
    }

    // Backfill ownerId for legacy sessions restored without one (multi-user only)
    if (!session.ownerId && ws._clayUser && usersModule.isMultiUser()) {
      session.ownerId = ws._clayUser.id;
      sm.saveSessionFile(session);
    }

    // Keep any pending scheduled message alive when user sends a regular message

    var userMsg2 = { type: "user_message", text: msg.text || "" };
    if (clientMessageId) userMsg2.clientMessageId = clientMessageId;
    if (wasProcessing && steer) {
      userMsg2.steerDuringProcessing = true;
      userMsg2.queueId = queueId;
      userMsg2.queuedPending = true;
    } else if (wasProcessing) {
      userMsg2.queuedDuringProcessing = true;
      userMsg2.queueId = queueId;
      userMsg2.queuedPending = true;
    }
    // Attach sender info for multi-user attribution (backward-compatible: old clients ignore these)
    if (ws._clayUser) {
      userMsg2.from = ws._clayUser.id;
      userMsg2.fromName = ws._clayUser.displayName || ws._clayUser.username || "";
    }
    var savedImagePaths = [];
    if (msg.images && msg.images.length > 0) {
      userMsg2.imageCount = msg.images.length;
      // Save images as files, store URL references in history
      var imageRefs = [];
      for (var imgIdx = 0; imgIdx < msg.images.length; imgIdx++) {
        var img = msg.images[imgIdx];
        var savedName = saveImageFile(img.mediaType, img.data, getLinuxUserForSession(session));
        if (savedName) {
          imageRefs.push({ mediaType: img.mediaType, file: savedName });
          savedImagePaths.push(path.join(imagesDir, savedName));
        }
      }
      if (imageRefs.length > 0) {
        userMsg2.imageRefs = imageRefs;
      }
    }
    if (msg.pastes && msg.pastes.length > 0) {
      userMsg2.pastes = msg.pastes;
    }
    if (!userMsg2._ts) userMsg2._ts = Date.now();
    session.history.push(userMsg2);
    sm.appendToSessionFile(session, userMsg2);
    if (!userMsg2.queuedDuringProcessing) {
      sendToSessionOthers(ws, session.localId, hydrateImageRefs(userMsg2));
    }

    if (!session.title) {
      var titleSource = msg.text || "";
      if (msg.pastes && msg.pastes.length > 0) {
        titleSource += (titleSource ? "\n\n" : "") + msg.pastes.join("\n\n");
      }
      session.title = meaningfulTextTitle(titleSource, 50) || (msg.text || "Image").substring(0, 50);
      session.titleAutoGenerated = true;
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
      // Sync auto-title to SDK
      if (session.cliSessionId) {
        adapter.renameSession(session.cliSessionId, session.title, { dir: cwd }).catch(function(e) {
          console.error("[project] SDK renameSession failed:", e.message);
        });
      }
    }

    var fullText = msg.text || "";
    if (shouldRetryAfterApiError(session, msg.text || "")) {
      fullText = "Retry the previous provider/API failure and continue the interrupted work. Do not treat the API error text as the task; resume the work that was interrupted before that failure.";
    }

    // Prepend handoff context invisibly on the first message after a vendor handoff
    if (session.handoffContext) {
      fullText = session.handoffContext +
        "\n\n<current_user_message>\n" +
        fullText +
        "\n</current_user_message>\n\n" +
        "Answer only the <current_user_message> above. Use <clay_handoff_context> only as prior reference.";
      var handoffTurnsRemaining = typeof session.handoffContextTurnsRemaining === "number" ? session.handoffContextTurnsRemaining : 4;
      handoffTurnsRemaining--;
      if (handoffTurnsRemaining <= 0) {
        session.handoffContext = null;
        session.handoffContextTurnsRemaining = 0;
      } else {
        session.handoffContextTurnsRemaining = handoffTurnsRemaining;
      }
      session.handoffFrom = null;
      sm.saveSessionFile(session);
    }

    // Prepend saved image paths so Claude can copy/save them
    if (savedImagePaths.length > 0) {
      var imgPathLines = savedImagePaths.map(function (p) { return "[Uploaded image: " + p + "]"; }).join("\n");
      fullText = imgPathLines + (fullText ? "\n" + fullText : "");
    }
    if (msg.pastes && msg.pastes.length > 0) {
      for (var pi = 0; pi < msg.pastes.length; pi++) {
        if (fullText) fullText += "\n\n";
        fullText += msg.pastes[pi];
      }
    }

    // Inject pending @mention context so the current agent sees the exchange
    if (session.pendingMentionContexts && session.pendingMentionContexts.length > 0) {
      var mentionPrefix = session.pendingMentionContexts.join("\n\n");
      session.pendingMentionContexts = [];
      fullText = mentionPrefix + "\n\n" + fullText;
    }

    // Inject active terminal context sources (delta only: send new output since last message)
    var TERM_CONTEXT_MAX = 8192; // 8KB max per terminal per message
    var TERM_HEAD_SIZE = 2048;   // keep first 2KB for error context
    var TERM_TAIL_SIZE = 6144;   // keep last 6KB for recent state
    var ctxSources = loadContextSources(slug, session.localId);
    if (ctxSources.length > 0) {
      if (!session._termContextCursors) session._termContextCursors = {};
      var termContextParts = [];
      for (var ci = 0; ci < ctxSources.length; ci++) {
        var srcId = ctxSources[ci];
        if (srcId.startsWith("term:")) {
          var termId = parseInt(srcId.split(":")[1], 10);
          var sb = tm.getScrollback(termId);
          if (sb) {
            var lastCursor;
            if (termId in session._termContextCursors) {
              lastCursor = session._termContextCursors[termId];
              // Terminal was recycled (closed and reopened with same ID) -- reset cursor
              if (lastCursor > sb.totalBytesWritten) lastCursor = 0;
            } else {
              // First time seeing this terminal -- include last 8KB (what user can see now)
              lastCursor = Math.max(0, sb.totalBytesWritten - TERM_CONTEXT_MAX);
            }
            var newBytes = sb.totalBytesWritten - lastCursor;
            session._termContextCursors[termId] = sb.totalBytesWritten;
            if (newBytes <= 0) continue;
            // Build timestamped delta from chunks
            var deltaChunks = [];
            var bytePos = sb.bufferStart;
            for (var chunkIdx = 0; chunkIdx < sb.chunks.length; chunkIdx++) {
              var chunk = sb.chunks[chunkIdx];
              var chunkEnd = bytePos + chunk.data.length;
              if (chunkEnd > lastCursor) {
                // This chunk has new content
                var chunkData = chunk.data;
                if (bytePos < lastCursor) {
                  // Partial chunk: only the part after lastCursor
                  chunkData = chunkData.slice(lastCursor - bytePos);
                }
                deltaChunks.push({ ts: chunk.ts, data: chunkData });
              }
              bytePos = chunkEnd;
            }
            if (deltaChunks.length === 0) continue;
            // Format with timestamps: group by second to avoid excessive timestamps
            var lines = [];
            var lastTimeSec = 0;
            for (var di = 0; di < deltaChunks.length; di++) {
              var dc = deltaChunks[di];
              var cleaned = dc.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
              if (!cleaned) continue;
              var timeSec = Math.floor(dc.ts / 1000);
              if (timeSec !== lastTimeSec) {
                var d = new Date(dc.ts);
                var timeStr = d.toTimeString().slice(0, 8); // HH:MM:SS
                lines.push("[" + timeStr + "] " + cleaned);
                lastTimeSec = timeSec;
              } else {
                lines.push(cleaned);
              }
            }
            var delta = lines.join("").trim();
            if (!delta) continue;
            var termInfo = tm.list().find(function(t) { return t.id === termId; });
            var termTitle = termInfo ? termInfo.title : "Terminal " + termId;
            var header;
            if (delta.length > TERM_CONTEXT_MAX) {
              var head = delta.slice(0, TERM_HEAD_SIZE);
              var tail = delta.slice(-TERM_TAIL_SIZE);
              var omittedBytes = delta.length - TERM_HEAD_SIZE - TERM_TAIL_SIZE;
              var omittedLines = delta.slice(TERM_HEAD_SIZE, delta.length - TERM_TAIL_SIZE).split("\n").length;
              delta = head + "\n\n... (" + omittedLines + " lines / " + Math.round(omittedBytes / 1024) + "KB omitted) ...\n\n" + tail;
              header = "[New terminal output from " + termTitle + " (large output, head+tail shown)]";
            } else {
              header = "[New terminal output from " + termTitle + "]";
            }
            termContextParts.push(header + "\n```\n" + delta + "\n```");
          }
        }
      }
      if (termContextParts.length > 0) {
        fullText = termContextParts.join("\n\n") + "\n\n" + fullText;
      }
    }

    // Collect email context (async: requires IMAP fetch for checked email accounts)
    var emailSources = ctxSources.filter(function(id) { return id.startsWith("email:"); });
    var emailContextPromise;
    if (emailSources.length > 0 && _email) {
      var emailUserId = (ws._clayUser && ws._clayUser.id) || "default";
      emailContextPromise = _email.getEmailContext(emailUserId, session.localId).catch(function () { return ""; });
    } else {
      emailContextPromise = Promise.resolve("");
    }

    // Collect browser tab context (async: requires round-trip to client extension)
    var _browserTabList = browserState._browserTabList;
    var tabSources = ctxSources.filter(function(id) {
      if (!id.startsWith("tab:")) return false;
      // Only include tabs that currently exist in the browser
      var tid = parseInt(id.split(":")[1], 10);
      return !!_browserTabList[tid];
    });

    // Wait for email context, then proceed with browser tab context and dispatch
    emailContextPromise.then(function (emailCtxText) {
      if (emailCtxText) {
        fullText = emailCtxText + "\n\n" + fullText;
      }

    if (tabSources.length > 0) {
      // Request tab context from all active browser tab sources
      var tabPromises = tabSources.map(function(srcId) {
        var tabId = parseInt(srcId.split(":")[1], 10);
        return requestTabContext(tabId);
      });
      Promise.all(tabPromises).then(function(results) {
        var tabContextParts = [];
        var screenshotImages = [];

        for (var ti = 0; ti < results.length; ti++) {
          if (!results[ti]) continue;
          var tabId2 = parseInt(tabSources[ti].split(":")[1], 10);
          var tabInfo = _browserTabList[tabId2];
          var tabLabel = tabInfo ? (tabInfo.title || tabInfo.url || "Tab " + tabId2) : "Tab " + tabId2;
          var r = results[ti];
          var parts = [];

          // Console logs
          if (r.console && r.console.logs) {
            try {
              var logs = typeof r.console.logs === "string" ? JSON.parse(r.console.logs) : r.console.logs;
              if (logs && logs.length > 0) {
                var logLines = [];
                var logSlice = logs.slice(-50);
                for (var li = 0; li < logSlice.length; li++) {
                  var entry = logSlice[li];
                  var ts = entry.ts ? new Date(entry.ts).toTimeString().slice(0, 8) : "";
                  var lvl = (entry.level || "log").toUpperCase();
                  logLines.push("[" + ts + " " + lvl + "] " + (entry.text || ""));
                }
                parts.push("Console:\n" + logLines.join("\n"));
              }
            } catch (e) {
              // ignore parse errors
            }
          }

          // Network requests
          if (r.network && r.network.network) {
            try {
              var netLog = typeof r.network.network === "string" ? JSON.parse(r.network.network) : r.network.network;
              if (netLog && netLog.length > 0) {
                var netLines = [];
                var netSlice = netLog.slice(-30);
                for (var ni = 0; ni < netSlice.length; ni++) {
                  var req = netSlice[ni];
                  var line = (req.method || "GET") + " " + (req.url || "") + " " + (req.status || 0) + " " + (req.duration || 0) + "ms";
                  if (req.error) line += " [" + req.error + "]";
                  netLines.push(line);
                }
                parts.push("Network (last " + netSlice.length + " requests):\n" + netLines.join("\n"));
              }
            } catch (e) {
              // ignore parse errors
            }
          }

          // Page text (from tab_page_text command)
          if (r.pageText && (r.pageText.text || r.pageText.value)) {
            var pageContent = r.pageText.text || r.pageText.value;
            if (pageContent.length > 0) {
              if (pageContent.length > 32768) {
                pageContent = pageContent.substring(0, 32768) + "\n... (truncated)";
              }
              parts.push("Page text:\n" + pageContent);
            }
          }

          // Screenshot -- save to disk and add to images for SDK
          if (r.screenshot && r.screenshot.image) {
            try {
              var screenshotData = r.screenshot.image;
              var screenshotName = saveImageFile("image/png", screenshotData, getLinuxUserForSession(session));
              if (screenshotName) {
                var screenshotPath = path.join(imagesDir, screenshotName);
                // Add to images array for SDK multimodal
                screenshotImages.push({
                  mediaType: "image/png",
                  data: screenshotData,
                  file: screenshotName,
                  tabTitle: tabLabel,
                  tabUrl: tabInfo ? tabInfo.url : "",
                  tabFavIconUrl: tabInfo ? tabInfo.favIconUrl : ""
                });
                parts.push("[Screenshot saved: " + screenshotPath + "]");
              }
            } catch (e) {
              // ignore screenshot save errors
            }
          }

          if (r.console && r.console.error) {
            parts.push("(Console error: " + r.console.error + ")");
          }
          if (r.network && r.network.error) {
            parts.push("(Network error: " + r.network.error + ")");
          }

          if (parts.length > 0) {
            tabContextParts.push("[Browser tab: " + tabLabel + "]\n" + parts.join("\n\n"));
          }
        }

        if (tabContextParts.length > 0) {
          fullText = "[The following browser tab data is automatically attached as context sources. Do NOT call browser_read_page, browser_console, browser_network, or browser_screenshot for these tabs -- the data is already here.]\n\n" +
            tabContextParts.join("\n\n---\n\n") + "\n\n" + fullText;
        }

        // If screenshots were captured, send context preview cards and add to SDK images
        if (screenshotImages.length > 0) {
          if (!msg.images) msg.images = [];
          for (var si = 0; si < screenshotImages.length; si++) {
            var ss = screenshotImages[si];
            // Save context_preview to history so it restores on session load
            var previewEntry = {
              type: "context_preview",
              tab: {
                title: ss.tabTitle || "",
                url: ss.tabUrl || "",
                favIconUrl: ss.tabFavIconUrl || "",
                screenshotFile: ss.file
              }
            };
            session.history.push(previewEntry);
            // Send context card to all clients
            sendToSession(session.localId, {
              type: "context_preview",
              tab: {
                title: ss.tabTitle || "",
                url: ss.tabUrl || "",
                favIconUrl: ss.tabFavIconUrl || "",
                screenshotUrl: "/p/" + slug + "/images/" + ss.file
              }
            });
            // Add to SDK images for multimodal
            msg.images.push({ mediaType: ss.mediaType, data: ss.data });
          }
          sm.saveSessionFile(session);
        }

        dispatchPreparedToSdk(session, fullText, msg.images, steer, queueId, msg.text || "", displayImageCount, clientMessageId, msg.pastes || null);
      });
    } else {
      dispatchPreparedToSdk(session, fullText, msg.images, steer, queueId, msg.text || "", displayImageCount, clientMessageId, msg.pastes || null);
    }

    }); // emailContextPromise.then

    return true;
  }

  return {
    handleUserMessage: handleUserMessage,
    flushQueuedUserMessage: flushQueuedUserMessage,
    syncNotesKnowledge: syncNotesKnowledge,
  };
}

module.exports = { attachUserMessage: attachUserMessage };
