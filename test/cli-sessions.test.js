var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

test("Codex import keeps first user prompt even when it starts with injected instructions", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-history-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var threadId = "019edd6c-e1c7-76c0-b42d-b8a4c6a89874";
  var rolloutDir = path.join(tmpHome, ".codex", "sessions", "2026", "06", "19");
  fs.mkdirSync(rolloutDir, { recursive: true });

  var rolloutPath = path.join(rolloutDir, "rollout-2026-06-19T03-09-21-" + threadId + ".jsonl");
  var firstUser = "--- Instructions from CLAUDE.md ---\n# CLAUDE.md\n\nIssue: reproduce the auth timeout toast";
  var lines = [
    JSON.stringify({
      timestamp: "2026-06-19T01:09:23.713Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: projectDir,
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-19T01:09:23.714Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: firstUser,
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-19T01:09:24.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I will inspect the issue first.",
      },
    }),
  ];
  fs.writeFileSync(rolloutPath, lines.join("\n") + "\n");

  try {
    var cliSessions = require("../lib/cli-sessions");
    var history = cliSessions.readCodexHistorySync(tmpHome, threadId, projectDir);

    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].type, "user_message");
    assert.strictEqual(history[0].text, firstUser);
    assert.strictEqual(history[1].type, "delta");
    assert.strictEqual(history[1].text, "I will inspect the issue first.");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("CLI session import preserves original message timestamps as _ts", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cli-ts-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var cliSessions = require("../lib/cli-sessions");
  var sessionId = "bb167370-2320-4e85-9fb2-116135ea5d56";

  var encoded = cliSessions.encodeCwd(projectDir);
  var projDir = path.join(tmpHome, ".claude", "projects", encoded);
  fs.mkdirSync(projDir, { recursive: true });

  var userTs = "2026-05-28T09:42:23.729Z";
  var asstTs = "2026-05-28T09:42:27.110Z";
  var lines = [
    JSON.stringify({ type: "mode", mode: "default" }),
    JSON.stringify({
      type: "user",
      timestamp: userTs,
      message: { role: "user", content: "Hello from the past" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: asstTs,
      message: { role: "assistant", content: [{ type: "text", text: "A reply from the past" }] },
    }),
  ];
  fs.writeFileSync(path.join(projDir, sessionId + ".jsonl"), lines.join("\n") + "\n");

  try {
    var history = cliSessions.readCliSessionHistorySync(tmpHome, projectDir, sessionId);

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].type, "user_message");
    assert.strictEqual(history[0]._ts, Date.parse(userTs));
    assert.strictEqual(history[1].type, "delta");
    assert.strictEqual(history[1]._ts, Date.parse(asstTs));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
