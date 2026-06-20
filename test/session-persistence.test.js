var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

test("loads missing handoff context for GitHub Copilot sessions", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-"));
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

    var storageId = "claude-before-handoff";
    var lines = [
      JSON.stringify({
        type: "meta",
        localId: 1,
        cliSessionId: "copilot-runtime-1",
        storageId: storageId,
        title: "Vendor handoff",
        createdAt: Date.now(),
        vendor: "github-copilot",
      }),
      JSON.stringify({ type: "user_message", text: "Original Claude-side context", _ts: Date.now() }),
      JSON.stringify({ type: "delta", text: "Work completed before switching", _ts: Date.now() }),
      JSON.stringify({ type: "vendor_switched", fromVendor: "claude", toVendor: "github-copilot", _ts: Date.now() }),
      JSON.stringify({ type: "user_message", text: "Continue with Copilot", _ts: Date.now() }),
      JSON.stringify({ type: "session_id", cliSessionId: "copilot-runtime-1", _ts: Date.now() }),
    ];
    fs.writeFileSync(path.join(sessionsDir, storageId + ".jsonl"), lines.join("\n") + "\n");

    var createSessionManager = require("../lib/sessions").createSessionManager;
    var sm = createSessionManager({
      cwd: projectDir,
      send: function () {},
    });
    var session = sm.sessions.get(1);

    assert.strictEqual(session.vendor, "github-copilot");
    assert.ok(session.handoffContext, "handoff context should be recovered for Copilot");
    assert.ok(session.handoffContext.indexOf("Original Claude-side context") !== -1);
    assert.ok(session.handoffContext.indexOf("Continue with Copilot") === -1);

    var savedMeta = JSON.parse(fs.readFileSync(path.join(sessionsDir, storageId + ".jsonl"), "utf8").split("\n")[0]);
    assert.strictEqual(savedMeta.handoffContextRecovered, true);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("runtime session id changes keep a stable storage id", function () {
  var saved = 0;
  var recorded = [];
  var sm = {
    saveSessionFile: function () {
      saved++;
    },
    sendAndRecord: function (session, obj) {
      recorded.push(obj);
    },
    sendToSession: function () {},
    modelsByVendor: {},
    availableModels: [],
  };
  var processor = require("../lib/sdk-message-processor").attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test",
    isMate: false,
    mateDisplayName: "",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    getSDK: function () { return null; },
    adapter: { vendor: "github-copilot" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
  });
  var session = {
    localId: 1,
    vendor: "github-copilot",
    history: [],
    cliSessionId: "runtime-1",
    storageId: null,
  };

  processor.processSDKMessage(session, { sessionId: "runtime-2" });

  assert.strictEqual(session.storageId, "runtime-1");
  assert.strictEqual(session.cliSessionId, "runtime-2");
  assert.strictEqual(saved, 1);
  assert.deepStrictEqual(recorded, []);
});

test("saved session metadata omits volatile local id", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;

  try {
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];

    var createSessionManager = require("../lib/sessions").createSessionManager;
    var sm = createSessionManager({
      cwd: projectDir,
      send: function () {},
    });
    var session = sm.createSessionRaw({
      vendor: "codex",
      storageId: "stable-storage-id",
    });
    session.title = "Task launched session";
    sm.saveSessionFile(session);

    var utils = require("../lib/utils");
    var encoded = utils.encodeCwd(projectDir);
    var metaPath = path.join(tmpHome, "sessions", encoded, "stable-storage-id.jsonl");
    var meta = JSON.parse(fs.readFileSync(metaPath, "utf8").split("\n")[0]);

    assert.strictEqual(meta.storageId, "stable-storage-id");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(meta, "localId"), false);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("persisted restart interruption does not auto-resume again", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-"));
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

    var storageId = "interrupted-session";
    var ts = Date.now() - 1000;
    var lines = [
      JSON.stringify({
        type: "meta",
        cliSessionId: storageId,
        storageId: storageId,
        title: "Interrupted once",
        createdAt: ts,
        vendor: "codex",
      }),
      JSON.stringify({ type: "user_message", text: "do work", _ts: ts }),
      JSON.stringify({ type: "thinking_start", _ts: ts + 1 }),
      JSON.stringify({
        type: "info",
        text: "Session was interrupted by a Clay restart. Clay will continue it when you reopen this session.",
        _ts: ts + 2,
      }),
      JSON.stringify({ type: "done", code: 1, _ts: ts + 3 }),
      JSON.stringify({ type: "thinking_stop", _ts: ts + 4 }),
    ];
    fs.writeFileSync(path.join(sessionsDir, storageId + ".jsonl"), lines.join("\n") + "\n");

    var createSessionManager = require("../lib/sessions").createSessionManager;
    var sm = createSessionManager({
      cwd: projectDir,
      send: function () {},
    });
    var session = sm.sessions.get(1);

    assert.strictEqual(session.interruptedByRestart, true);
    assert.strictEqual(session.restartResumeEligible, false);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("task launch result reports stable session id separately from local router id", function () {
  var launcher = require("../lib/project-task-launcher").attachTaskLauncher({
    cwd: process.cwd(),
    sm: {},
    sdk: {},
    sendTo: function () {},
    usersModule: {},
    getSessionForWs: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
    onProcessingChanged: function () {},
  });
  var result = launcher.taskLaunchResult({
    localId: 42,
    storageId: "stable-storage-id",
    cliSessionId: null,
    title: "Error Message when auto logged out",
  });

  assert.strictEqual(result.sessionId, "stable-storage-id");
  assert.strictEqual(result.localSessionId, 42);
  assert.strictEqual(result.claySessionId, 42);
  assert.strictEqual(result.storageId, "stable-storage-id");
  assert.strictEqual(result.cliSessionId, null);
});

test("auto-resume turns do not bump lastActivity, genuine input does", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;

  try {
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];

    var utils = require("../lib/utils");
    var sessionsDir = path.join(tmpHome, "sessions", utils.encodeCwd(projectDir));
    fs.mkdirSync(sessionsDir, { recursive: true });
    var lines = [
      JSON.stringify({ type: "meta", cliSessionId: "sess-1", storageId: "sess-1", title: "Session", createdAt: 1000, vendor: "claude", mode: "gui" }),
      JSON.stringify({ type: "user_message", text: "hi", _ts: 1000 }),
    ];
    fs.writeFileSync(path.join(sessionsDir, "sess-1.jsonl"), lines.join("\n") + "\n");

    var sm = require("../lib/sessions").createSessionManager({ cwd: projectDir, send: function () {} });
    var session = sm.sessions.get(1);
    var baseline = session.lastActivity;

    // A synthetic auto-resume turn marks the session; its appends must NOT move
    // the session up the recency-sorted list (the "sessions keep jumping" bug).
    session._suppressActivityBump = true;
    sm.appendToSessionFile(session, { type: "user_message", text: "↻ Resuming the interrupted response", _ts: Date.now() });
    sm.appendToSessionFile(session, { type: "delta", text: "resumed work", _ts: Date.now() });
    assert.strictEqual(session.lastActivity, baseline, "auto-resume appends must not bump lastActivity");

    // Genuine user input clears the flag, restoring normal recency bumping.
    session._suppressActivityBump = false;
    sm.appendToSessionFile(session, { type: "user_message", text: "real message", _ts: Date.now() });
    assert.ok(session.lastActivity > baseline, "genuine input must bump lastActivity");
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("hidden Claude sessions remain importable when CLI descriptor parsing fails", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-session-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var oldClayHome = process.env.CLAY_HOME;
  var originalHomedir = os.homedir;
  process.env.CLAY_HOME = path.join(tmpHome, ".clay");
  os.homedir = function () { return tmpHome; };

  try {
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];

    var utils = require("../lib/utils");
    var encoded = utils.encodeCwd(projectDir);
    var sessionsDir = path.join(process.env.CLAY_HOME, "sessions", encoded);
    var claudeDir = path.join(tmpHome, ".claude", "projects", encoded);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });

    var sessionId = "991ad98d-18a4-499c-bd8a-3287a81c36b1";
    var createdAt = 1760000000000;
    var title = "Screenshot-backed hidden session";
    var lines = [
      JSON.stringify({
        type: "meta",
        cliSessionId: sessionId,
        storageId: sessionId,
        title: title,
        createdAt: createdAt,
        vendor: "claude",
        hidden: true,
      }),
      JSON.stringify({ type: "user_message", text: title, _ts: createdAt }),
    ];
    fs.writeFileSync(path.join(sessionsDir, sessionId + ".jsonl"), lines.join("\n") + "\n");

    var largeLine = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{\"data\":\"" + "x".repeat(70 * 1024) + "\"}}]}}\n";
    fs.writeFileSync(path.join(claudeDir, sessionId + ".jsonl"), largeLine);

    var sm = require("../lib/sessions").createSessionManager({ cwd: projectDir, send: function () {} });
    var importable = sm.listAdoptableCliSessions("claude");
    var found = importable.filter(function (item) { return item.cliSessionId === sessionId; })[0];

    assert.ok(found, "hidden session should still be listed for import");
    assert.strictEqual(found.hidden, true);
    assert.strictEqual(found.title, title);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    os.homedir = originalHomedir;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/sessions")];
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
