// project-pr-qa-verdict.js - Parse the AI PR QA verdict comment.
//
// The QA bot posts its verdict as a top-level PR conversation comment (an issue
// comment, NOT a formal review and NOT an inline diff comment), flagged by a
// stable HTML marker so it can be told apart from other bot comments (preview
// URLs, etc.). The auto-launch pr-review source surfaces this verdict to the
// fix session: a FAIL must be addressed; a PASS is still read for anything worth
// fixing. Pure helpers only (no I/O) so they are trivially testable.

var QA_MARKER = "<!-- ai-pr-qa-verdict -->";

// Derive PASS/FAIL from a QA comment body. The explicit "QA Verdict: PASS/FAIL"
// line is the primary signal; the 🟢/🔴 emoji is a fallback. Returns "pass",
// "fail", or "" when neither is present.
function parseQaVerdict(body) {
  var text = String(body || "");
  var m = text.match(/QA\s+Verdict:\s*\**\s*(PASS|FAIL)/i);
  if (m) return m[1].toLowerCase();
  if (text.indexOf("🔴") !== -1) return "fail"; // 🔴
  if (text.indexOf("🟢") !== -1) return "pass"; // 🟢
  return "";
}

// Given the raw array of issue comments for a PR, return the NEWEST AI QA
// verdict comment as { verdict, findings, ts }, or null when none is present.
// `toMs` converts an ISO timestamp to epoch ms (injected so callers reuse their
// own implementation); falls back to Date.parse when omitted.
function extractQaFromComments(comments, toMs) {
  if (!Array.isArray(comments)) return null;
  function ms(iso) {
    if (toMs) return toMs(iso);
    var n = Date.parse(iso);
    return Number.isFinite(n) ? n : 0;
  }
  var newest = null;
  var newestTs = -1;
  for (var i = 0; i < comments.length; i++) {
    var c = comments[i];
    if (!c || !c.body || String(c.body).indexOf(QA_MARKER) === -1) continue;
    var ts = ms(c.created_at);
    if (ts >= newestTs) { newestTs = ts; newest = c; }
  }
  if (!newest) return null;
  return {
    verdict: parseQaVerdict(newest.body),
    findings: String(newest.body).split(QA_MARKER).join("").trim(),
    ts: newestTs < 0 ? 0 : newestTs,
  };
}

module.exports = {
  QA_MARKER: QA_MARKER,
  parseQaVerdict: parseQaVerdict,
  extractQaFromComments: extractQaFromComments,
};
