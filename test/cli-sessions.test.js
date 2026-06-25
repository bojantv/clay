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

test("hidden sessions are surfaced for import and can be restored", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hidden-import-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;

  try {
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];

    var utils = require("../lib/utils");
    var encoded = utils.encodeCwd(projectDir);
    var sessionsDir = path.join(tmpHome, "sessions", encoded);
    fs.mkdirSync(sessionsDir, { recursive: true });

    // A closed/archived github-copilot session. Its provider id is recorded in
    // the history (session_id event), which is what made it "known" and got it
    // excluded from the import picker before the fix.
    var hidden = [
      JSON.stringify({
        type: "meta", localId: 1, cliSessionId: "copilot-hidden-1",
        storageId: "copilot-hidden-1", title: "#1975 closed early", hidden: true,
        vendor: "github-copilot", model: "gpt-5.5", createdAt: Date.now(),
      }),
      JSON.stringify({ type: "user_message", text: "fix it", _ts: Date.now() }),
      JSON.stringify({ type: "session_id", cliSessionId: "copilot-hidden-1", _ts: Date.now() }),
    ];
    fs.writeFileSync(path.join(sessionsDir, "copilot-hidden-1.jsonl"), hidden.join("\n") + "\n");

    // A compaction source — its content lives in a successor, so it must NOT
    // be surfaced as a separate importable entry.
    var source = [
      JSON.stringify({
        type: "meta", localId: 2, cliSessionId: "codex-source-1",
        storageId: "codex-source-1", title: "pre-compaction source", hidden: true,
        vendor: "codex", compactedIntoLocalId: 1, createdAt: Date.now(),
      }),
      JSON.stringify({ type: "session_id", cliSessionId: "codex-source-1", _ts: Date.now() }),
    ];
    fs.writeFileSync(path.join(sessionsDir, "codex-source-1.jsonl"), source.join("\n") + "\n");

    var createSessionManager = require("../lib/sessions").createSessionManager;
    var sm = createSessionManager({ cwd: projectDir, send: function () {} });

    // gpt-5.5 maps to the codex family, so it shows under the codex picker...
    var codexList = sm.listAdoptableCliSessions("codex");
    var found = codexList.filter(function (s) { return s.cliSessionId === "copilot-hidden-1"; });
    assert.strictEqual(found.length, 1, "hidden copilot session should be importable under codex filter");
    assert.strictEqual(found[0].hidden, true);
    assert.strictEqual(found[0].vendor, "github-copilot");

    // ...but not under the claude picker (wrong family).
    var claudeList = sm.listAdoptableCliSessions("claude");
    assert.strictEqual(claudeList.filter(function (s) { return s.cliSessionId === "copilot-hidden-1"; }).length, 0);

    // The compaction source is never offered.
    assert.strictEqual(codexList.concat(claudeList).filter(function (s) { return s.cliSessionId === "codex-source-1"; }).length, 0);

    // Importing the hidden session un-hides it.
    var localId = sm.importCliSession("copilot-hidden-1", "github-copilot");
    assert.ok(localId, "import should return the restored session's localId");
    assert.strictEqual(sm.sessions.get(localId).cliSessionId, "copilot-hidden-1");
    assert.strictEqual(sm.sessions.get(localId).hidden, false);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];
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
