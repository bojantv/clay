var test = require("node:test");
var assert = require("node:assert");

var codexAdapter = require("../lib/yoke/adapters/codex");
var routing = codexAdapter._test;

test("Codex item events with another thread id are ignored", function () {
  var state = { threadId: "thread-a", turnId: "turn-a" };
  var ok = routing.shouldRouteServerEvent(state, {}, "item/completed", {
    threadId: "thread-b",
    turnId: "turn-b",
    item: { id: "item-b", type: "agentMessage" },
  });

  assert.strictEqual(ok, false);
});

test("Codex item events with matching nested turn id are routed", function () {
  var state = { threadId: "thread-a", turnId: "turn-a" };
  var ok = routing.shouldRouteServerEvent(state, {}, "item/started", {
    item: {
      id: "item-a",
      type: "userMessage",
      turnId: "turn-a",
    },
  });

  assert.strictEqual(ok, true);
});

test("Codex item events without thread or turn identity are ignored after thread binding", function () {
  var state = { threadId: "thread-a", turnId: "turn-a" };
  var ok = routing.shouldRouteServerEvent(state, {}, "item/started", {
    item: {
      id: "shared-item",
      type: "userMessage",
    },
  });

  assert.strictEqual(ok, false);
});

test("Codex resume handle ignores pre-bind events from other threads", function () {
  var state = { threadId: null, turnId: null };
  var ok = routing.shouldRouteServerEvent(state, { resumeSessionId: "thread-a" }, "turn/started", {
    threadId: "thread-b",
    turnId: "turn-b",
  });

  assert.strictEqual(ok, false);
});

test("Codex context usage uses current context tokens, not cumulative total tokens", function () {
  var state = {
    _tokenUsageShapeLogged: true,
    model: "gpt-5.5",
    threadId: "thread-a",
    turnId: "turn-a",
    aborted: false,
  };

  routing.flattenEvent({
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        last: {
          inputTokens: 247000,
          outputTokens: 1200,
          totalTokens: 248200,
        },
        total: {
          inputTokens: 760000,
          outputTokens: 12000,
          totalTokens: 772000,
        },
        modelContextWindow: 258400,
      },
    },
  }, state);

  assert.strictEqual(state.lastContextUsedTokens, 247000);
  assert.strictEqual(state.contextWindowTokens, 258400);

  var events = routing.flattenEvent({
    method: "turn/completed",
    params: {
      usage: {
        input_tokens: 120,
        output_tokens: 20,
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "result";
  })[0];

  assert.strictEqual(result.contextUsedTokens, 247000);
  assert.strictEqual(result.contextWindow, 258400);
});

function makeStreamState() {
  return {
    blockCounter: 0,
    threadId: "thread-a",
    turnId: "turn-a",
    textBlocks: {},
    textLengths: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    toolBlocks: {},
    commandInputs: {},
    planTexts: {},
    agentBlockId: null,
    agentTextLen: 0,
  };
}

function streamText(state, sequence) {
  var out = "";
  for (var i = 0; i < sequence.length; i++) {
    var events = routing.flattenEvent(sequence[i], state) || [];
    for (var j = 0; j < events.length; j++) {
      if (events[j].yokeType === "text_delta") out += events[j].text;
    }
  }
  return out;
}

// Regression: Codex app-server streams agent text via item/agentMessage/delta
// AND emits item/updated/item/completed carrying the growing full text. When
// the delta event's item id can't be linked to item.id, the two paths used to
// track length under separate keys and BOTH streamed the text, producing
// per-token doubling in the chat bubble ("HelloHello  world world").
test("Codex agentMessage does not double text when deltas lack a linkable item id", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/started", params: { item: { id: "msg1", type: "agentMessage", text: "" } } },
    { method: "item/agentMessage/delta", params: { delta: "Hello" } },
    { method: "item/updated", params: { item: { id: "msg1", type: "agentMessage", text: "Hello" } } },
    { method: "item/agentMessage/delta", params: { delta: " world" } },
    { method: "item/updated", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
  ]);
  assert.strictEqual(out, "Hello world");
});

test("Codex agentMessage streams once when deltas carry a matching itemId", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { itemId: "msg1", delta: "Hello" } },
    { method: "item/agentMessage/delta", params: { itemId: "msg1", delta: " world" } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
  ]);
  assert.strictEqual(out, "Hello world");
});

test("Codex agentMessage reconciles a tail the deltas never streamed", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { itemId: "msg1", delta: "Hello" } },
    // Final text is longer than what deltas delivered (dropped tail).
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
  ]);
  assert.strictEqual(out, "Hello world");
});

test("Codex streams two sequential agent messages in one turn without bleed", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { delta: "First." } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "First." } } },
    { method: "item/agentMessage/delta", params: { delta: "Second." } },
    { method: "item/completed", params: { item: { id: "msg2", type: "agentMessage", text: "Second." } } },
  ]);
  assert.strictEqual(out, "First.Second.");
});
