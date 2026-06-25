var test = require("node:test");
var assert = require("node:assert");

var helpers = require("../lib/yoke/adapters/github-copilot-helpers");

test("Copilot prompt blocks omit images unless the agent advertises image support", function () {
  var images = [{ mediaType: "image/png", data: "abc123" }];
  var blocks = helpers.copilotPromptBlocks("runtime", "look at this", images, false);

  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, "text");
  assert.match(blocks[0].text, /does not advertise image prompt support/);
});

test("Copilot prompt blocks include ACP images when supported", function () {
  var images = [{ mediaType: "image/png", data: "abc123" }];
  var blocks = helpers.copilotPromptBlocks("runtime", "look at this", images, true);

  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(blocks[1], {
    type: "image",
    data: "abc123",
    mimeType: "image/png",
  });
});

test("Copilot image support follows ACP agent prompt capabilities", function () {
  assert.strictEqual(helpers.copilotSupportsPromptImages({ promptCapabilities: { image: true } }), true);
  assert.strictEqual(helpers.copilotSupportsPromptImages({ promptCapabilities: { image: false } }), false);
  assert.strictEqual(helpers.copilotSupportsPromptImages({}), false);
});

test("startCopilotSession resumes when a session id and resume capability are present", async function () {
  var calls = [];
  var connection = {
    resumeSession: function (p) { calls.push(["resume", p.sessionId]); return Promise.resolve({ sessionId: p.sessionId }); },
    loadSession: function (p) { calls.push(["load", p.sessionId]); return Promise.resolve({ sessionId: p.sessionId }); },
    newSession: function () { calls.push(["new"]); return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { sessionCapabilities: { resume: true } };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stored-id" });

  assert.strictEqual(session.sessionId, "stored-id");
  assert.deepStrictEqual(calls, [["resume", "stored-id"]]);
});

test("startCopilotSession backfills the session id when resume acks without echoing it", async function () {
  var connection = {
    resumeSession: function () { return Promise.resolve({}); }, // ack with no sessionId
    newSession: function () { return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { sessionCapabilities: { resume: true } };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stored-id" });

  assert.strictEqual(session.sessionId, "stored-id");
});

test("startCopilotSession backfills the session id when load returns void", async function () {
  var connection = {
    loadSession: function () { return Promise.resolve(undefined); },
    newSession: function () { return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { loadSession: true };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stored-id" });

  assert.strictEqual(session.sessionId, "stored-id");
});

test("startCopilotSession falls back to a fresh session when resume rejects (stale id after restart)", async function () {
  var calls = [];
  var connection = {
    resumeSession: function (p) { calls.push(["resume", p.sessionId]); return Promise.reject(new Error("Invalid params")); },
    loadSession: function (p) { calls.push(["load", p.sessionId]); return Promise.reject(new Error("Invalid params")); },
    newSession: function () { calls.push(["new"]); return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { sessionCapabilities: { resume: true } };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stale-id" });

  assert.strictEqual(session.sessionId, "fresh");
  assert.deepStrictEqual(calls, [["resume", "stale-id"], ["new"]]);
});

test("startCopilotSession starts fresh when no prior session id is supplied", async function () {
  var calls = [];
  var connection = {
    resumeSession: function () { calls.push(["resume"]); return Promise.resolve({ sessionId: "r" }); },
    newSession: function () { calls.push(["new"]); return Promise.resolve({ sessionId: "fresh" }); },
  };
  var session = await helpers.startCopilotSession(connection, { sessionCapabilities: { resume: true } }, { cwd: "/x" });

  assert.strictEqual(session.sessionId, "fresh");
  assert.deepStrictEqual(calls, [["new"]]);
});
