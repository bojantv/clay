var test = require("node:test");
var assert = require("node:assert");

var { parseQaVerdict, extractQaFromComments, QA_MARKER } = require("../lib/project-pr-qa-verdict");

test("parseQaVerdict reads explicit PASS/FAIL verdict line", function () {
  assert.strictEqual(parseQaVerdict("🟢 QA Verdict: PASS\nall good"), "pass");
  assert.strictEqual(parseQaVerdict("🔴 QA Verdict: FAIL\nbroken"), "fail");
  assert.strictEqual(parseQaVerdict("QA Verdict: **PASS**"), "pass");
});

test("parseQaVerdict falls back to the status emoji", function () {
  assert.strictEqual(parseQaVerdict("## 🤖 AI PR QA\n🟢 looks fine"), "pass");
  assert.strictEqual(parseQaVerdict("## 🤖 AI PR QA\n🔴 nope"), "fail");
});

test("parseQaVerdict returns empty when no signal present", function () {
  assert.strictEqual(parseQaVerdict("just a normal comment"), "");
  assert.strictEqual(parseQaVerdict(""), "");
  assert.strictEqual(parseQaVerdict(null), "");
});

test("extractQaFromComments ignores non-QA comments (e.g. preview URL)", function () {
  var comments = [
    { body: "<!-- preview-url-comment -->\nPreview ready", created_at: "2026-06-30T14:15:42Z" },
    { body: "looks great, ship it", created_at: "2026-06-30T14:20:00Z" },
  ];
  assert.strictEqual(extractQaFromComments(comments), null);
});

test("extractQaFromComments returns the QA verdict and strips the marker", function () {
  var comments = [
    { body: "<!-- preview-url-comment -->\nPreview ready", created_at: "2026-06-30T14:15:42Z" },
    { body: QA_MARKER + "\n## 🤖 AI PR QA\n🟢 QA Verdict: PASS\nNo issues found.", created_at: "2026-06-30T14:21:00Z" },
  ];
  var qa = extractQaFromComments(comments);
  assert.strictEqual(qa.verdict, "pass");
  assert.strictEqual(qa.findings.indexOf(QA_MARKER), -1, "marker stripped from findings");
  assert.ok(qa.findings.indexOf("AI PR QA") !== -1, "body preserved");
  assert.strictEqual(qa.ts, Date.parse("2026-06-30T14:21:00Z"));
});

test("extractQaFromComments picks the NEWEST QA comment when several exist", function () {
  var comments = [
    { body: QA_MARKER + "\n🔴 QA Verdict: FAIL\nold run", created_at: "2026-06-30T10:00:00Z" },
    { body: QA_MARKER + "\n🟢 QA Verdict: PASS\nlatest run", created_at: "2026-06-30T15:00:00Z" },
  ];
  var qa = extractQaFromComments(comments);
  assert.strictEqual(qa.verdict, "pass");
  assert.ok(qa.findings.indexOf("latest run") !== -1);
});

test("extractQaFromComments honours an injected toMs", function () {
  var comments = [{ body: QA_MARKER + "\n🟢 QA Verdict: PASS", created_at: "whatever" }];
  var qa = extractQaFromComments(comments, function () { return 42; });
  assert.strictEqual(qa.ts, 42);
});
