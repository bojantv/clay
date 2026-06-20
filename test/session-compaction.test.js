var test = require("node:test");
var assert = require("node:assert");

var compaction = require("../lib/project-session-compaction");
var processorModule = require("../lib/sdk-message-processor");

test("compact continuation prompt moves latest user message into current block", function () {
  var session = {
    localId: 7,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.5",
    history: [
      { type: "user_message", text: "Build the staff helper", _ts: 1 },
      { type: "delta", text: "Implemented the first version.", _ts: 2 },
      { type: "user_message", text: "why did this stop?", _ts: 3 },
      { type: "result", usage: null, _ts: 4 },
    ],
  };

  var latest = compaction.findLatestUserMessage(session);
  var prompt = compaction.buildCompactContinuationPrompt(session, {
    latestUserMessage: latest,
    cwd: "/tmp/project",
    maxChars: 20000,
  });

  assert.ok(prompt.indexOf("Build the staff helper") !== -1);
  assert.ok(prompt.indexOf("Implemented the first version.") !== -1);
  assert.ok(prompt.indexOf("<current_user_message>\nwhy did this stop?\n</current_user_message>") !== -1);
  assert.ok(prompt.indexOf("Use this transcript only to preserve continuity") !== -1);
});

test("Codex empty zero-usage turn triggers compact-and-continue once", function () {
  var recorded = [];
  var compactCalls = 0;
  var sm = {
    modelsByVendor: { codex: ["gpt-5.5"] },
    availableModels: ["gpt-5.5"],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function () {},
    sendAndRecord: function (session, obj) {
      recorded.push(obj);
      session.history.push(obj);
    },
  };
  var processor = processorModule.attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test",
    isMate: false,
    mateDisplayName: "",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    getSDK: function () { return null; },
    adapter: { vendor: "codex" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {
      compactAndContinue: function () {
        compactCalls++;
        return { localId: 2 };
      },
    },
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
  });
  var session = {
    localId: 1,
    vendor: "codex",
    history: [
      { type: "user_message", text: "hello", _ts: 1 },
    ],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: true,
    responsePreview: "",
    streamedText: false,
  };

  processor.processSDKMessage(session, { yokeType: "turn_start" });
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: null,
    usage: null,
    modelUsage: { "gpt-5.5": { contextWindow: null } },
    sessionId: "thread-1",
  });
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: null,
    usage: null,
    modelUsage: { "gpt-5.5": { contextWindow: null } },
    sessionId: "thread-1",
  });

  assert.strictEqual(compactCalls, 1);
  assert.ok(recorded.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("Clay is compacting") !== -1;
  }));
});
