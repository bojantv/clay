// project-pr-review-state.js - Per-PR bookkeeping for the auto-launch
// "pr-review" source. Tracks how many auto-fix passes a PR has had, the
// watermark of the newest review feedback already acted on, and the commit
// SHAs the workflow itself pushed (so the agent's own fix commits never reset
// the pass budget — only a commit YOU push does).
//
// State lives server-side per project in .clay/tasks/pr-review-state.json:
//   {
//     "trialview/v2#1903": {
//       "passCount": 1,
//       "reviewWatermark": 1718966400000,  // ms; set at LAUNCH so a re-tick
//                                            // does not double-fire on the same feedback
//       "seenCommits": ["abc123"],          // SHAs the workflow pushed (snapshot on completion)
//       "status": "active",                 // active | capped | done
//       "lastLaunchAt": 1718966400000,
//       "updatedAt": 1718966400000
//     }
//   }
//
// Pure-ish helper: all decisions are derived from the item passed in by the
// task source plus the stored entry. Follows CommonJS per MODULE_MAP.md.

var fs = require("fs");
var path = require("path");

var MAX_SEEN_COMMITS = 10;

function createPrReviewState(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var statePath = path.join(tasksDir, "pr-review-state.json");

  function read() {
    try {
      var parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function write(all) {
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      var tmp = statePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
      fs.renameSync(tmp, statePath);
    } catch (e) {
      console.error("[pr-review-state] failed to save:", e.message);
    }
  }

  function defaultEntry() {
    return {
      passCount: 0,
      reviewWatermark: 0,
      seenCommits: [],
      status: "active",
      lastLaunchAt: 0,
      updatedAt: 0,
    };
  }

  function get(key) {
    var all = read();
    return Object.assign(defaultEntry(), all[key] || {});
  }

  // A head SHA we have never recorded as one of our own pushes means YOU pushed
  // new work — reset the pass budget. The first time we see a PR seenCommits is
  // empty, so this never fires spuriously on a brand-new PR.
  function isExternalCommit(entry, headSha) {
    if (!headSha) return false;
    if (!entry.seenCommits || entry.seenCommits.length === 0) return false;
    return entry.seenCommits.indexOf(headSha) === -1;
  }

  // Decide whether to launch an auto-fix session for this PR right now.
  // item: { key, head_sha, ci_failing, latestFeedbackTs }
  // Applies (and persists) a budget reset when YOU pushed since our last fix.
  // Returns { launch: bool, reason: string, passNumber: number, maxPasses }.
  function shouldLaunch(item, maxPasses) {
    var key = item.key;
    if (!key) return { launch: false, reason: "missing key", passNumber: 0, maxPasses: maxPasses };
    var max = parseInt(maxPasses, 10);
    if (!Number.isFinite(max) || max <= 0) max = 2;

    var all = read();
    var entry = Object.assign(defaultEntry(), all[key] || {});

    if (isExternalCommit(entry, item.head_sha)) {
      // Fresh human commit -> new budget. Keep the watermark so we don't replay
      // stale comments; new commits usually draw fresh reviews anyway.
      entry.passCount = 0;
      entry.status = "active";
      entry.seenCommits = [];
      entry.updatedAt = Date.now();
      all[key] = entry;
      write(all);
    }

    if (entry.passCount >= max) {
      return { launch: false, reason: "capped", passNumber: entry.passCount, maxPasses: max };
    }

    var hasNewFeedback = (item.latestFeedbackTs || 0) > (entry.reviewWatermark || 0);
    var ciFailing = !!item.ci_failing;
    if (!hasNewFeedback && !ciFailing) {
      return { launch: false, reason: "nothing-to-do", passNumber: entry.passCount, maxPasses: max };
    }
    return {
      launch: true,
      reason: ciFailing ? (hasNewFeedback ? "ci+reviews" : "ci") : "reviews",
      passNumber: entry.passCount + 1,
      maxPasses: max,
    };
  }

  // Record that we are starting a pass NOW: bump the counter and advance the
  // watermark so a tick between session-end and next-poll won't re-fire on the
  // same feedback. Returns the updated entry.
  function recordLaunch(item, maxPasses) {
    var key = item.key;
    if (!key) return null;
    var max = parseInt(maxPasses, 10);
    if (!Number.isFinite(max) || max <= 0) max = 2;
    var all = read();
    var entry = Object.assign(defaultEntry(), all[key] || {});
    entry.passCount += 1;
    var ts = item.latestFeedbackTs || 0;
    if (ts > entry.reviewWatermark) entry.reviewWatermark = ts;
    entry.lastLaunchAt = Date.now();
    entry.status = entry.passCount >= max ? "capped" : "active";
    entry.updatedAt = Date.now();
    all[key] = entry;
    write(all);
    return entry;
  }

  // Snapshot the PR head SHA after a pass finished so the agent's own fix
  // commit is remembered as "ours" and never triggers a reset.
  function recordCompletion(key, headShaAfter) {
    if (!key) return;
    var all = read();
    var entry = Object.assign(defaultEntry(), all[key] || {});
    if (headShaAfter && entry.seenCommits.indexOf(headShaAfter) === -1) {
      entry.seenCommits.push(headShaAfter);
      if (entry.seenCommits.length > MAX_SEEN_COMMITS) {
        entry.seenCommits = entry.seenCommits.slice(-MAX_SEEN_COMMITS);
      }
    }
    entry.updatedAt = Date.now();
    all[key] = entry;
    write(all);
  }

  return {
    read: read,
    get: get,
    shouldLaunch: shouldLaunch,
    recordLaunch: recordLaunch,
    recordCompletion: recordCompletion,
  };
}

module.exports = { createPrReviewState: createPrReviewState };
