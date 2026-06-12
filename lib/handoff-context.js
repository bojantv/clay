var path = require("path");

var DEFAULT_MAX_CONTEXT_CHARS = 240000;
var DEFAULT_MAX_ENTRY_CHARS = 60000;

function vendorName(vendor) {
  if (vendor === "codex") return "Codex";
  if (vendor === "claude") return "Claude";
  if (vendor === "github-copilot") return "GitHub Copilot";
  return vendor || "the previous vendor";
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); }
  catch (e) { return String(value); }
}

function compactWhitespace(value) {
  return asText(value).replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function clipMiddle(value, maxChars) {
  var text = asText(value);
  if (!maxChars || text.length <= maxChars) return text;
  if (maxChars < 2000) {
    return text.substring(0, maxChars) + "\n[... omitted " + (text.length - maxChars) + " chars ...]";
  }
  var head = Math.floor(maxChars * 0.72);
  var tail = maxChars - head;
  return text.substring(0, head) +
    "\n\n[... omitted " + (text.length - maxChars) + " chars ...]\n\n" +
    text.substring(text.length - tail);
}

function formatTime(entry) {
  if (!entry || !entry._ts) return "";
  try { return " @ " + new Date(entry._ts).toISOString(); }
  catch (e) { return ""; }
}

function formatInput(input) {
  if (input == null) return "";
  var text = asText(input);
  if (!text || text === "{}") return "";
  return "\nInput:\n" + clipMiddle(text, DEFAULT_MAX_ENTRY_CHARS);
}

function pushBlock(blocks, title, body, entry) {
  var cleanBody = compactWhitespace(body);
  if (!cleanBody && !title) return;
  var line = "### " + title + formatTime(entry);
  if (cleanBody) line += "\n" + clipMiddle(cleanBody, DEFAULT_MAX_ENTRY_CHARS);
  blocks.push(line);
}

function describeImages(entry, imagesDir) {
  var lines = [];
  if (entry && Array.isArray(entry.imageRefs)) {
    for (var i = 0; i < entry.imageRefs.length; i++) {
      var ref = entry.imageRefs[i] || {};
      var label = ref.file || ("image-" + (i + 1));
      if (imagesDir && ref.file) label = path.join(imagesDir, ref.file);
      lines.push("- " + (ref.mediaType || "image") + ": " + label);
    }
  }
  if (entry && Array.isArray(entry.images)) {
    for (var j = 0; j < entry.images.length; j++) {
      var img = entry.images[j] || {};
      lines.push("- " + (img.mediaType || "image") + (img.url ? ": " + img.url : ""));
    }
  }
  if (lines.length === 0 && entry && entry.imageCount) {
    lines.push("- " + entry.imageCount + " image(s), original binary data not attached to this text handoff");
  }
  if (lines.length === 0) return "";
  return "\nImages:\n" + lines.join("\n");
}

function describePastes(entry) {
  if (!entry || !Array.isArray(entry.pastes) || entry.pastes.length === 0) return "";
  var lines = [];
  for (var i = 0; i < entry.pastes.length; i++) {
    lines.push("Paste " + (i + 1) + ":\n" + clipMiddle(entry.pastes[i], DEFAULT_MAX_ENTRY_CHARS));
  }
  return "\nPastes:\n" + lines.join("\n\n");
}

function describeToolResult(entry, activeTools) {
  var label = (entry && entry.id && activeTools[entry.id]) ? activeTools[entry.id] : ((entry && entry.id) || "tool");
  var body = "";
  if (entry && entry.is_error) body += "[error]\n";
  if (entry && entry.content != null) body += asText(entry.content);
  if (entry && Array.isArray(entry.images) && entry.images.length > 0) {
    body += "\n\nImages returned: " + entry.images.length;
  }
  return { title: "Tool result: " + label, body: body };
}

function appendAssistantIfNeeded(blocks, assistantParts, entry) {
  if (assistantParts.length === 0) return;
  pushBlock(blocks, "Assistant", assistantParts.join(""), entry || null);
  assistantParts.length = 0;
}

function trimBlocks(header, blocks, footer, maxChars) {
  var separator = "\n\n";
  var fixedLength = header.length + footer.length + (separator.length * 2);
  var budget = Math.max(4000, (maxChars || DEFAULT_MAX_CONTEXT_CHARS) - fixedLength);
  var selected = [];
  var selectedLength = 0;
  var omitted = 0;
  for (var i = blocks.length - 1; i >= 0; i--) {
    var block = blocks[i];
    var needed = block.length + separator.length;
    if (selected.length === 0 || selectedLength + needed <= budget) {
      selected.unshift(block);
      selectedLength += needed;
    } else {
      omitted++;
    }
  }
  if (omitted > 0) {
    selected.unshift("[Older context omitted: " + omitted + " transcript block(s) exceeded the handoff limit.]");
  }
  return header + separator + selected.join(separator) + separator + footer;
}

function buildHandoffContextFromHistory(history, options) {
  var opts = options || {};
  var blocks = [];
  var assistantParts = [];
  var activeTools = {};
  var h = Array.isArray(history) ? history : [];
  for (var i = 0; i < h.length; i++) {
    var entry = h[i];
    if (!entry || entry._internal) continue;
    if (entry.type === "delta") {
      if (entry.text) assistantParts.push(entry.text);
      continue;
    }
    appendAssistantIfNeeded(blocks, assistantParts, entry);

    if (entry.type === "user_message") {
      var userLabel = entry.fromName ? ("User (" + entry.fromName + ")") : "User";
      var userBody = asText(entry.text || "") + describeImages(entry, opts.imagesDir) + describePastes(entry);
      pushBlock(blocks, userLabel, userBody, entry);
    } else if (entry.type === "mention_user" || entry.type === "user_mention") {
      var mentionBody = asText(entry.text || "") + describeImages(entry, opts.imagesDir) + describePastes(entry);
      pushBlock(blocks, "User mention", mentionBody, entry);
    } else if (entry.type === "mention_response") {
      pushBlock(blocks, "Mention response" + (entry.mateName ? " from " + entry.mateName : ""), entry.text || "", entry);
    } else if (entry.type === "tool_start") {
      if (entry.id) activeTools[entry.id] = entry.name || entry.id;
    } else if (entry.type === "tool_executing") {
      if (entry.id) activeTools[entry.id] = entry.name || activeTools[entry.id] || entry.id;
      pushBlock(blocks, "Tool call: " + (entry.name || entry.id || "tool"), formatInput(entry.input), entry);
    } else if (entry.type === "tool_result") {
      var result = describeToolResult(entry, activeTools);
      pushBlock(blocks, result.title, result.body, entry);
    } else if (entry.type === "slash_command_result") {
      pushBlock(blocks, "Local command output", entry.text || "", entry);
    } else if (entry.type === "plan_content") {
      pushBlock(blocks, "Plan content", entry.content || "", entry);
    } else if (entry.type === "task_started") {
      pushBlock(blocks, "Sub-agent started", entry.description || entry.taskId || "", entry);
    } else if (entry.type === "task_progress") {
      pushBlock(blocks, "Sub-agent progress", entry.summary || entry.description || entry.lastToolName || "", entry);
    } else if (entry.type === "task_updated") {
      pushBlock(blocks, "Sub-agent updated", entry.patch || "", entry);
    } else if (entry.type === "subagent_activity") {
      pushBlock(blocks, "Sub-agent activity", entry.text || "", entry);
    } else if (entry.type === "subagent_done") {
      pushBlock(blocks, "Sub-agent done", entry.summary || entry.status || "", entry);
    } else if (entry.type === "error") {
      pushBlock(blocks, "Error", entry.text || entry.message || "", entry);
    } else if (entry.type === "auth_required") {
      pushBlock(blocks, "Authentication required", (entry.text || "") + (entry.loginCommand ? "\nLogin command: " + entry.loginCommand : ""), entry);
    } else if (entry.type === "rate_limit") {
      pushBlock(blocks, "Rate limit", entry, entry);
    } else if (entry.type === "scheduled_message_sent") {
      pushBlock(blocks, "Scheduled message sent", "", entry);
    } else if (entry.type === "scheduled_message_cancelled") {
      pushBlock(blocks, "Scheduled message cancelled", "", entry);
    } else if (entry.type === "vendor_switched") {
      pushBlock(blocks, "Vendor switched", (entry.fromVendor || "unknown") + " -> " + (entry.toVendor || "unknown"), entry);
    } else if (entry.type === "result") {
      pushBlock(blocks, "Turn result", {
        duration: entry.duration || null,
        usage: entry.usage || null,
        modelUsage: entry.modelUsage || null,
        lastStreamInputTokens: entry.lastStreamInputTokens || null,
      }, entry);
    }
  }
  appendAssistantIfNeeded(blocks, assistantParts, null);
  if (blocks.length === 0) return null;

  var from = vendorName(opts.fromVendor);
  var to = vendorName(opts.toVendor || "the next vendor");
  var sourceLabel = opts.sourceLabel || ("previous " + from + " conversation");
  var header = "[Context from " + sourceLabel + ", prepared for " + to + " handoff]\n\n" +
    "This is Clay's reconstructed transcript for continuity. It includes the maximum saved chat context Clay can transfer as text: user messages, visible assistant text, attachments by reference, tool calls/results, local command output, errors, plans, sub-agent updates, and vendor-switch markers. Hidden thinking text is intentionally omitted.";
  header += "\nThe new provider's native session store may be empty because this is an in-place handoff. Do not treat an empty native session store, checkpoint list, or turn list as evidence that the Clay chat has no prior history; the transcript below is the prior history.";
  if (opts.cwd) header += "\nProject: " + opts.cwd;
  if (opts.targetRouteLabel) header += "\nTarget route: " + opts.targetRouteLabel;
  if (opts.targetModel) header += "\nSelected/active model: " + opts.targetModel;
  if (opts.targetRouteLabel || opts.targetModel) {
    header += "\nThe target route/model above is the current runtime after the switch. It overrides any older provider, route, model, identity, or usage claims inside the transcript below.";
    header += "\nIf the user asks what they are using now, answer from the target route/model above. Do not introspect your own system prompt or speculate about a different hidden model.";
  }
  var footer = "Continue seamlessly from the above. Treat this transcript as prior conversation context for the same Clay chat, even though the underlying CLI session is fresh. For current provider/model identity, use the target route/model listed at the top of this handoff context.";
  return trimBlocks(header, blocks, footer, opts.maxChars || DEFAULT_MAX_CONTEXT_CHARS);
}

function buildHandoffContext(session, options) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  return buildHandoffContextFromHistory(history, options);
}

module.exports = {
  buildHandoffContext: buildHandoffContext,
  buildHandoffContextFromHistory: buildHandoffContextFromHistory,
  DEFAULT_MAX_CONTEXT_CHARS: DEFAULT_MAX_CONTEXT_CHARS,
};
