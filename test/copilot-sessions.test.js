var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

test("Copilot session descriptor strips Clay metadata and detects provider route", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-copilot-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-project-"));
  var sessionId = "copilot-session-1";
  var sessionDir = path.join(tmpHome, ".copilot", "session-state", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  var userPrompt = [
    "[Clay runtime metadata]",
    "Provider: GitHub Copilot CLI",
    "Requested model: claude-sonnet-4.6",
    "Verified model: claude-sonnet-4.6",
    "[/Clay runtime metadata]",
    "",
    "<clay_handoff_context>",
    "Old Claude transcript",
    "</clay_handoff_context>",
    "",
    "<current_user_message>",
    "Fix the logout toast",
    "</current_user_message>",
    "",
    "Answer only the <current_user_message> above.",
  ].join("\n");

  fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), [
    "cwd: \"" + projectDir + "\"",
    "created_at: \"2026-06-19T01:00:00.000Z\"",
    "updated_at: \"2026-06-19T01:02:00.000Z\"",
    "name: |-",
    "  [Clay runtime metadata]",
    "  Provider: GitHub Copilot CLI",
    "  Verified model: claude-sonnet-4.6",
    "  [/Clay runtime metadata]",
  ].join("\n") + "\n");

  var events = [
    {
      timestamp: "2026-06-19T01:01:00.000Z",
      type: "user.message",
      data: { content: userPrompt },
    },
    {
      timestamp: "2026-06-19T01:01:10.000Z",
      type: "assistant.message",
      data: { content: "I will inspect the logout flow." },
    },
  ];
  fs.writeFileSync(path.join(sessionDir, "events.jsonl"), JSON.stringify(events[0]) + "\n" + JSON.stringify(events[1]) + "\n");

  try {
    var copilotSessions = require("../lib/copilot-sessions");
    var desc = copilotSessions.readCopilotSessionDescriptor(tmpHome, sessionId, projectDir);
    var history = copilotSessions.readCopilotHistorySync(tmpHome, sessionId, projectDir);

    assert.strictEqual(desc.vendor, "github-copilot");
    assert.strictEqual(desc.copilotFamily, "claude");
    assert.strictEqual(desc.model, "claude-sonnet-4.6");
    assert.strictEqual(desc.providerRouteId, "claude-github-copilot");
    assert.strictEqual(desc.title, "Fix the logout toast");
    assert.strictEqual(history[0].type, "user_message");
    assert.strictEqual(history[0].text, "Fix the logout toast");
    assert.strictEqual(history[1].type, "delta");
    assert.strictEqual(history[1].text, "I will inspect the logout flow.");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
