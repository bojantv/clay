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
    assert.ok(session.handoffContext.indexOf("Continue with Copilot") !== -1);

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
