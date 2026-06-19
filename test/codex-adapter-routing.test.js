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
