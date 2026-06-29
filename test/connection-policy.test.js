var test = require("node:test");
var assert = require("node:assert");

// connection-policy.js is a browser ES module, but it is dependency-free on
// purpose, so it can be dynamically imported and exercised in node.
async function loadPolicy() {
  return await import("../lib/public/modules/connection-policy.js");
}

test("decideSocketAction: only an OPEN socket sends; everything else recovers", async function () {
  var { decideSocketAction } = await loadPolicy();
  // 1 === WebSocket.OPEN
  assert.strictEqual(decideSocketAction(1), "send");
  // The regression: a missing/connecting/closing/closed/zombie socket must NOT
  // silently drop the action — it must trigger a reconnect instead.
  assert.strictEqual(decideSocketAction(0), "reconnect", "CONNECTING -> reconnect");
  assert.strictEqual(decideSocketAction(2), "reconnect", "CLOSING -> reconnect");
  assert.strictEqual(decideSocketAction(3), "reconnect", "CLOSED -> reconnect");
  assert.strictEqual(decideSocketAction(-1), "reconnect", "no socket -> reconnect");
  assert.strictEqual(decideSocketAction(undefined), "reconnect", "undefined -> reconnect");
});

test("shouldProbeLiveness: probe a stale-pong socket, skip a fresh or pending one", async function () {
  var { shouldProbeLiveness } = await loadPolicy();
  var HEARTBEAT = 25000;
  // Fresh pong within the window: no probe needed.
  assert.strictEqual(shouldProbeLiveness(100000, 100000, HEARTBEAT, false), false);
  // Pong older than the heartbeat window: probe to catch a possible zombie.
  assert.strictEqual(shouldProbeLiveness(100000, 50000, HEARTBEAT, false), true);
  // Never received a pong: probe.
  assert.strictEqual(shouldProbeLiveness(100000, 0, HEARTBEAT, false), true);
  assert.strictEqual(shouldProbeLiveness(100000, undefined, HEARTBEAT, false), true);
  // A probe is already in flight: don't pile on another.
  assert.strictEqual(shouldProbeLiveness(100000, 50000, HEARTBEAT, true), false);
});

test("shouldProcessSocketMessage: only the currently-active socket may render", async function () {
  var { shouldProcessSocketMessage } = await loadPolicy();
  var current = { id: "B" };
  var discarded = { id: "A" };
  // Frame arrived on the socket that is still active: process it.
  assert.strictEqual(shouldProcessSocketMessage(current, current), true);
  // The regression: a frame arriving on a discarded socket (previous project,
  // still flushing during its async close) must NOT render into the new
  // project's view. Session ids are project-local and collide across projects,
  // so identity is the only reliable discriminator.
  assert.strictEqual(shouldProcessSocketMessage(discarded, current), false, "stale socket -> drop");
  // Defensive: missing sockets never process.
  assert.strictEqual(shouldProcessSocketMessage(null, current), false);
  assert.strictEqual(shouldProcessSocketMessage(current, null), false);
  assert.strictEqual(shouldProcessSocketMessage(null, null), false);
});
