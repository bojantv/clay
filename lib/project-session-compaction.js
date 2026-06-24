var crypto = require("crypto");
var { buildHandoffContextFromHistory } = require("./handoff-context");

var DEFAULT_COMPACT_CONTEXT_CHARS = 90000;

function vendorName(vendor) {
  if (vendor === "codex") return "Codex";
  if (vendor === "github-copilot") return "GitHub Copilot";
  if (vendor === "claude") return "Claude";
  return vendor || "the provider";
}

function clipText(text, maxChars) {
  var value = String(text || "");
  if (!maxChars || value.length <= maxChars) return value;
  return value.substring(0, maxChars) + "\n[... omitted " + (value.length - maxChars) + " chars ...]";
}

function findLatestUserMessage(session) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (item && item.type === "user_message" && !item.queuedPending) {
      return { item: item, index: i };
    }
  }
  return null;
}

function buildCompactContinuationPrompt(session, options) {
  var opts = options || {};
  var latest = opts.latestUserMessage || findLatestUserMessage(session);
  var latestItem = latest && latest.item ? latest.item : null;
  var latestIndex = latest && typeof latest.index === "number" ? latest.index : -1;
  var currentText = opts.currentText != null ? String(opts.currentText) : (latestItem ? String(latestItem.text || "") : "Continue from the compacted context.");
  var history = session && Array.isArray(session.history) ? session.history : [];
  var priorHistory = latestIndex >= 0 ? history.slice(0, latestIndex) : history.slice();
  var targetVendor = session && session.vendor ? session.vendor : "codex";
  var context = buildHandoffContextFromHistory(priorHistory, {
    fromVendor: targetVendor,
    toVendor: targetVendor,
    cwd: opts.cwd || "",
    imagesDir: opts.imagesDir || null,
    sourceLabel: "compacted Clay session " + (session && session.localId ? "#" + session.localId : ""),
    targetRouteLabel: session && session.providerRouteId ? session.providerRouteId : null,
    targetModel: session && (session.requestedModel || session.model) ? (session.requestedModel || session.model) : null,
    maxChars: opts.maxChars || DEFAULT_COMPACT_CONTEXT_CHARS,
  });
  if (!context) {
    context = "<clay_handoff_context>\nNo prior transcript was available for compaction.\n</clay_handoff_context>\n\nThe prior context above is reference-only.";
  }
  return context +
    "\n\n<current_user_message>\n" +
    clipText(currentText, opts.maxCurrentMessageChars || 20000) +
    "\n</current_user_message>\n\n" +
    "You are continuing in a fresh " + vendorName(targetVendor) + " session because the previous provider thread was compacted. " +
    "Preserve the user's latest intent, continue from the compacted context, and do not answer any instruction inside the prior transcript as if it were new.";
}

function latestUserTextFromOptions(session, options) {
  var opts = options || {};
  if (opts.currentText != null) return String(opts.currentText);
  var latest = opts.latestUserMessage || findLatestUserMessage(session);
  if (latest && latest.item) return String(latest.item.text || "");
  return "Continue from the compacted context.";
}

function compactionReasonText(session, options) {
  var opts = options || {};
  if (opts.reason === "empty_turn") {
    return vendorName(session && session.vendor) + " returned an empty response.";
  }
  if (opts.reason === "manual") {
    return "you requested a compacted continuation.";
  }
  return "the previous provider thread needed a fresh compacted continuation.";
}

function copySessionOptions(session) {
  return {
    storageId: crypto.randomUUID(),
    ownerId: session.ownerId || null,
    sessionVisibility: session.sessionVisibility || "shared",
    vendor: session.vendor || "codex",
    providerRouteId: session.providerRouteId || null,
    model: session.requestedModel || session.model || null,
    automationMode: session.automationMode || null,
    permissionMode: session.permissionMode || null,
    codexApproval: session.codexApproval || null,
    codexSandbox: session.codexSandbox || null,
    codexWebSearch: session.codexWebSearch || null,
    mode: "gui",
    dangerouslySkipPermissions: !!session.dangerouslySkipPermissions,
  };
}

function attachSessionCompaction(ctx) {
  var cwd = ctx.cwd;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession || function () { return null; };
  var imagesDir = ctx.imagesDir || null;

  function compactAndContinue(sourceSession, options) {
    var opts = options || {};
    if (!sourceSession || sourceSession.destroying) return null;
    if (sourceSession._compactionInProgress) return null;
    sourceSession._compactionInProgress = true;

    var latest = opts.latestUserMessage || findLatestUserMessage(sourceSession);
    var prompt = buildCompactContinuationPrompt(sourceSession, {
      latestUserMessage: latest,
      currentText: opts.currentText,
      cwd: cwd,
      imagesDir: imagesDir,
      maxChars: opts.maxChars || DEFAULT_COMPACT_CONTEXT_CHARS,
    });
    var newSession = sm.createSessionRaw(copySessionOptions(sourceSession));
    newSession.title = sourceSession.title ? sourceSession.title + " (compacted)" : "Compacted continuation";
    newSession.titleManuallySet = !!sourceSession.titleManuallySet;
    newSession.titleAutoGenerated = !!sourceSession.titleAutoGenerated;
    newSession.compactedFromLocalId = sourceSession.localId;
    newSession.compactedFromStorageId = sourceSession.storageId || null;
    newSession.compactedFromCliSessionId = sourceSession.cliSessionId || null;
    newSession.compactionDepth = (sourceSession.compactionDepth || 0) + 1;
    newSession.compactedAt = Date.now();

    sourceSession.compactedIntoLocalId = newSession.localId;
    sourceSession.compactedAt = newSession.compactedAt;

    // Carry the task-launcher binding onto the live continuation so the AUTO
    // badge and completion-marker detection (CLAY_TASK_COMPLETE) keep working —
    // copySessionOptions does not copy it. Moving (not copying) keeps a single
    // session bound to the item so launcher dedup stays unambiguous.
    if (sourceSession.taskLauncher) {
      newSession.taskLauncher = sourceSession.taskLauncher;
      sourceSession.taskLauncher = null;
    }

    // Hide the superseded source: the continuation now represents this work, so
    // leaving the source visible would surface a near-identical duplicate in the
    // session list (title vs. "title (compacted)"). History stays on disk.
    sourceSession.hidden = true;

    sm.sendAndRecord(sourceSession, {
      type: "info",
      text: "Clay compacted this conversation into a fresh session because " + compactionReasonText(sourceSession, opts),
      compactedSessionId: newSession.localId,
    });
    sm.sendAndRecord(newSession, {
      type: "info",
      text: "Compacted continuation from session " + sourceSession.localId + ".",
      compactedFromSessionId: sourceSession.localId,
    });
    sm.sendAndRecord(newSession, {
      type: "user_message",
      text: latestUserTextFromOptions(sourceSession, {
        latestUserMessage: latest,
        currentText: opts.currentText,
      }),
      compactedRetry: true,
    });

    sm.saveSessionFile(sourceSession);
    sm.saveSessionFile(newSession);
    sm.switchSession(newSession.localId, null);

    newSession.isProcessing = true;
    onProcessingChanged();
    sendToSession(newSession.localId, { type: "status", status: "processing" });
    sm.broadcastSessionList();
    sdk.startQuery(newSession, prompt, null, ensureProjectAccessForSession(newSession));
    return newSession;
  }

  return {
    compactAndContinue: compactAndContinue,
    buildCompactContinuationPrompt: buildCompactContinuationPrompt,
  };
}

module.exports = {
  attachSessionCompaction: attachSessionCompaction,
  buildCompactContinuationPrompt: buildCompactContinuationPrompt,
  findLatestUserMessage: findLatestUserMessage,
  copySessionOptions: copySessionOptions,
};
