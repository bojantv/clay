// Deterministically tracks which git worktree a session is actively editing in.
//
// A Clay project has one fixed cwd (the main checkout), but an agent may
// `git worktree add` and then do its real work in a worktree subdir. Rather
// than guess from prose — or ask the model, which can misreport — we match the
// directory of the agent's file-mutating tool calls (ground truth) against the
// repo's actual `git worktree list`, and read the branch straight from git. The
// result is cached on the session as `activeWorktree` and consumed by the
// workspace panel / dev server.

var { execFileSync } = require("child_process");
var fs = require("fs");
var path = require("path");
var wtmod = require("./worktree");

// Canonicalize a path (resolve symlinks like macOS /tmp -> /private/tmp) so
// git-reported roots and agent-reported file paths compare correctly. Works
// even when the file doesn't exist yet by realpath-ing its nearest existing
// ancestor and re-appending the rest.
function canon(p) {
  if (!p) return p;
  try { return fs.realpathSync(p); } catch (e) {}
  var dir = path.resolve(p);
  var tail = [];
  while (dir && dir !== path.dirname(dir)) {
    tail.push(path.basename(dir));
    dir = path.dirname(dir);
    try { return path.join(fs.realpathSync(dir), tail.slice().reverse().join(path.sep)); } catch (e) {}
  }
  return path.resolve(p);
}

// Tools whose input names a file the agent is writing/changing. Read-only tools
// (Read/Grep/Glob) are ignored on purpose: the agent often reads files in the
// main checkout while writing in a worktree, and we must not flip-flop.
var WRITE_TOOLS = {
  Edit: 1, Write: 1, MultiEdit: 1, NotebookEdit: 1, Create: 1,
  str_replace_editor: 1, str_replace_based_edit_tool: 1, apply_patch: 1,
};

var WT_LIST_TTL = 5000; // re-list worktrees at most this often per session

function gitLine(dir, args) {
  try {
    return execFileSync("git", args, {
      cwd: dir, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return "";
  }
}

// Resolve, once per session, the project's main checkout root and the project's
// path relative to it. The relative part lets us find the same subdir inside a
// worktree (monorepos keep the app in e.g. webapp/).
function computeAnchor(cwd) {
  var mainRoot = gitLine(cwd, ["rev-parse", "--show-toplevel"]);
  if (!mainRoot) return null;
  mainRoot = canon(mainRoot);
  return { mainRoot: mainRoot, sub: path.relative(mainRoot, canon(cwd)) };
}

// Pull an absolute file path out of a write-tool's input.
function editedFilePath(toolName, input) {
  if (!WRITE_TOOLS[toolName] || !input) return null;
  var p = input.file_path || input.path || input.notebook_path || null;
  if (typeof p !== "string" || !path.isAbsolute(p)) return null;
  return canon(p);
}

function isUnder(child, parent) {
  return child === parent || child.indexOf(parent + path.sep) === 0;
}

// Observe one tool call. Updates session.activeWorktree and returns true if it
// changed (so the caller could re-broadcast). Cheap: the worktree list is cached
// per session and matching is plain string work.
function noteTool(cwd, session, toolName, input) {
  if (!session || !cwd) return false;
  var filePath = editedFilePath(toolName, input);
  if (!filePath) return false;

  var anchor = session._wtAnchor;
  if (anchor === undefined) {
    anchor = computeAnchor(cwd);
    session._wtAnchor = anchor; // cache (may be null for non-git projects)
  }
  if (!anchor) return false;

  var nowMs = Date.now();
  if (!session._wtListAt || (nowMs - session._wtListAt) > WT_LIST_TTL) {
    try { session._wtList = wtmod.scanWorktrees(cwd) || []; } catch (e) { session._wtList = []; }
    session._wtListAt = nowMs;
  }
  var list = session._wtList || [];

  // Pick the linked worktree whose root is the longest prefix of the edited
  // file (handles worktrees nested inside the main checkout).
  var best = null;
  var bestRoot = null;
  var bestLen = -1;
  for (var i = 0; i < list.length; i++) {
    var root = canon(list[i].path);
    if (root === anchor.mainRoot) continue; // main checkout is not an override
    if (isUnder(filePath, root) && root.length > bestLen) { best = list[i]; bestRoot = root; bestLen = root.length; }
  }

  var prev = session.activeWorktree || null;
  if (!best) {
    // Edit landed in the main checkout (or outside any worktree) → drop override.
    if (prev) { session.activeWorktree = null; return true; }
    return false;
  }
  if (prev && path.resolve(prev.root) === bestRoot) return false; // unchanged
  session.activeWorktree = {
    root: bestRoot,
    branch: best.branch || path.basename(bestRoot),
    devCwd: anchor.sub ? path.join(bestRoot, anchor.sub) : bestRoot,
    at: nowMs,
  };
  return true;
}

module.exports = { noteTool: noteTool };
