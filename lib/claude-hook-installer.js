// claude-hook-installer.js
//
// Registers Clay's notification webhook in `~/.claude/settings.json` so the
// `claude` CLI fires a request to the Clay daemon whenever it surfaces a
// Notification (permission requests, idle prompts, etc.). This is what makes
// TUI sessions feel like first-class Clay sessions: the user gets the same
// toasts and push notifications they would in GUI mode.
//
// Design notes:
//   - Settings merge is idempotent: existing hooks are preserved, ours are
//     identified by a marker substring so re-runs don't duplicate them.
//   - The hook command uses curl with --max-time / --connect-timeout so that
//     a downed daemon can't stall claude's UI for more than ~1s.
//   - Multi-user mode: caller passes one home directory per OS user; we
//     write each user's own settings.json so per-user filtering works.

var fs = require("fs");
var path = require("path");

// Substring that uniquely identifies a Clay-installed hook entry so we can
// safely remove/replace it without touching user-authored hooks.
var CLAY_HOOK_MARKER = "clay:tui-notify";

// Allow-patterns Clay manages in ~/.claude/settings.json `permissions.allow`.
// These mirror sdk-bridge.js `checkToolWhitelist` so TUI sessions get the
// same auto-approval convenience as SDK sessions. Conservative: only
// commands that stay safe even under Claude Code's wildcard matching
// (compound commands like `ls && rm -rf /` would otherwise sneak past
// `Bash(ls *)`).
//
// Pattern syntax note: claude 2.x uses space-wildcard form `Bash(cmd *)`
// for prefix matching. The older colon form `Bash(cmd:*)` is flagged as
// legacy in the CLI and no longer reliably matches argument-bearing
// commands - the TUI was still prompting for read-only invocations like
// `ls -la` even with the allow-list installed. Patterns below use the
// modern form. The bare command (e.g. `Bash(ls)`) is included alongside
// the wildcard so zero-arg invocations are also covered.
//
// User-authored entries are preserved -- on re-install we only strip
// patterns that appear in this constant list.
var CLAY_MANAGED_ALLOW = [
  // Read-only built-in tools (no side effects).
  "Read", "Glob", "Grep", "WebFetch", "WebSearch",

  // Clay's own MCP servers. Strictly read/safe by design.
  "mcp__clay-browser__browser_watch_tab",
  "mcp__clay-browser__browser_unwatch_tab",
  "mcp__clay-debate__propose_debate",
  "mcp__clay-datastore__*",
  "mcp__clay-history__*",
  // Email: read-side only. Send / reply / mark_read still prompt.
  "mcp__clay-email__clay_read_email",
  "mcp__clay-email__clay_read_email_body",
  "mcp__clay-email__clay_search_email",
  "mcp__clay-email__clay_list_labels",

  // Safe Bash commands. Match the curated set in sdk-bridge.js's
  // safeBashCommands, restricted to ones whose pure read-only behavior
  // doesn't depend on argument shape.
  "Bash(ls)", "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
  "Bash(file *)", "Bash(stat *)", "Bash(find *)", "Bash(tree)", "Bash(tree *)",
  "Bash(du *)", "Bash(df)", "Bash(df *)", "Bash(readlink *)", "Bash(realpath *)",
  "Bash(basename *)", "Bash(dirname *)",
  "Bash(grep *)", "Bash(rg *)", "Bash(ag *)", "Bash(ack *)",
  "Bash(fgrep *)", "Bash(egrep *)",
  "Bash(which *)", "Bash(type *)", "Bash(whereis *)",
  "Bash(echo)", "Bash(echo *)", "Bash(printf *)", "Bash(env)", "Bash(env *)", "Bash(printenv)", "Bash(printenv *)",
  "Bash(pwd)", "Bash(whoami)", "Bash(id)", "Bash(id *)", "Bash(groups)", "Bash(groups *)",
  "Bash(date)", "Bash(date *)", "Bash(uname)", "Bash(uname *)", "Bash(hostname)", "Bash(uptime)",
  "Bash(arch)", "Bash(nproc)", "Bash(free)", "Bash(free *)",
  "Bash(lsb_release *)", "Bash(sw_vers)", "Bash(sw_vers *)", "Bash(locale)", "Bash(locale *)",
  // Git read-only subcommands. Listed individually so write subcommands
  // (commit, push, reset, etc.) still prompt.
  "Bash(git status)", "Bash(git status *)", "Bash(git log)", "Bash(git log *)",
  "Bash(git diff)", "Bash(git diff *)", "Bash(git show)", "Bash(git show *)",
  "Bash(git branch)", "Bash(git branch *)", "Bash(git tag)", "Bash(git tag *)",
  "Bash(git remote)", "Bash(git remote *)", "Bash(git config --get *)",
  "Bash(git rev-parse *)", "Bash(git ls-files)", "Bash(git ls-files *)",
  "Bash(git blame *)", "Bash(git describe)", "Bash(git describe *)",
  // Package manager read-only subcommands
  "Bash(npm list)", "Bash(npm list *)", "Bash(npm ls)", "Bash(npm ls *)",
  "Bash(npm view *)", "Bash(npm outdated)", "Bash(npm outdated *)",
  "Bash(npm config get *)", "Bash(yarn list)", "Bash(yarn list *)", "Bash(pnpm list)", "Bash(pnpm list *)",
  // Version checks
  "Bash(node --version)", "Bash(npm --version)", "Bash(python --version)",
  "Bash(python3 --version)", "Bash(go version)", "Bash(ruby --version)",
  // Text processing (pure stdin/stdout)
  "Bash(jq *)", "Bash(yq *)", "Bash(sort)", "Bash(sort *)", "Bash(uniq)", "Bash(uniq *)",
  "Bash(cut *)", "Bash(tr *)", "Bash(awk *)", "Bash(sed *)",
  "Bash(paste *)", "Bash(column *)", "Bash(rev)", "Bash(rev *)", "Bash(tac)", "Bash(tac *)",
  "Bash(nl)", "Bash(nl *)", "Bash(fmt)", "Bash(fmt *)", "Bash(comm *)", "Bash(join *)",
  // Comparison / hashing (read-only)
  "Bash(diff *)", "Bash(cmp *)", "Bash(md5sum *)", "Bash(sha256sum *)",
  "Bash(sha1sum *)", "Bash(shasum *)", "Bash(cksum *)", "Bash(base64)", "Bash(base64 *)",
  "Bash(xxd *)", "Bash(od *)", "Bash(hexdump *)",
  // Calendar / math
  "Bash(cal)", "Bash(cal *)", "Bash(bc)", "Bash(bc *)", "Bash(expr *)", "Bash(factor *)", "Bash(seq *)",
  // Process / network introspection (read-only)
  "Bash(ps)", "Bash(ps *)", "Bash(top)", "Bash(top *)", "Bash(htop)", "Bash(pgrep *)", "Bash(lsof)", "Bash(lsof *)",
  "Bash(netstat)", "Bash(netstat *)", "Bash(ss)", "Bash(ss *)", "Bash(ifconfig)", "Bash(ifconfig *)", "Bash(ip *)",
  "Bash(dig *)", "Bash(nslookup *)", "Bash(host *)",
];

function buildHookCommand(notifyUrl) {
  // Read stdin once (the JSON Claude Code pipes in), then post it. --max-time
  // and --connect-timeout cap total hook latency around ~1s even if the
  // daemon is down. --insecure (-k) is needed because Clay's optional TLS
  // mode uses a locally generated CA that curl won't trust by default;
  // safe to skip verification since we're going to 127.0.0.1. Output is
  // silenced so it doesn't leak into the TUI. The marker comment keeps the
  // entry recognizable when we re-merge.
  var insecure = notifyUrl.indexOf("https://") === 0 ? " --insecure" : "";
  return "curl --silent --show-error --max-time 1 --connect-timeout 1" + insecure +
    " -X POST -H 'Content-Type: application/json' --data-binary @- " +
    JSON.stringify(notifyUrl) + " > /dev/null 2>&1 # " + CLAY_HOOK_MARKER;
}

function readSettings(settingsPath) {
  try {
    var raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function writeSettings(settingsPath, data) {
  var dir = path.dirname(settingsPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n");
}

// Merge our Notification hook into the user's settings.json without
// clobbering anything else. Returns true if the file changed.
function mergeHook(settingsPath, command) {
  var data = readSettings(settingsPath);
  if (!data.hooks || typeof data.hooks !== "object") data.hooks = {};
  if (!Array.isArray(data.hooks.Notification)) data.hooks.Notification = [];

  // Strip any prior Clay entries before inserting the fresh one so port /
  // URL changes propagate cleanly.
  var before = JSON.stringify(data.hooks.Notification);
  var cleaned = [];
  for (var i = 0; i < data.hooks.Notification.length; i++) {
    var group = data.hooks.Notification[i];
    if (!group || !Array.isArray(group.hooks)) { cleaned.push(group); continue; }
    var filtered = group.hooks.filter(function (h) {
      return !(h && typeof h.command === "string" && h.command.indexOf(CLAY_HOOK_MARKER) !== -1);
    });
    if (filtered.length > 0) cleaned.push({ matcher: group.matcher || "", hooks: filtered });
    else if (group.matcher) cleaned.push(group);
  }
  data.hooks.Notification = cleaned;

  data.hooks.Notification.push({
    matcher: "",
    hooks: [{ type: "command", command: command }],
  });

  var after = JSON.stringify(data.hooks.Notification);
  if (before === after) return false;
  writeSettings(settingsPath, data);
  return true;
}

/**
 * Install (or refresh) the Notification hook in one or more user home dirs.
 *
 * opts:
 *   notifyUrl  -- full URL Clay listens on, e.g. "http://127.0.0.1:2633/api/tui-notify".
 *   homeDirs   -- array of absolute paths to user home directories. Each one
 *                 gets its own settings.json updated. Defaults to [os.homedir()].
 *
 * Returns { installed: [paths], errors: [{path, error}] } so the caller can log.
 */
function installNotificationHook(opts) {
  opts = opts || {};
  var os = require("os");
  var homes = opts.homeDirs && opts.homeDirs.length ? opts.homeDirs : [os.homedir()];
  var notifyUrl = opts.notifyUrl;
  if (!notifyUrl) throw new Error("installNotificationHook: notifyUrl is required");

  var command = buildHookCommand(notifyUrl);
  var installed = [];
  var errors = [];
  for (var i = 0; i < homes.length; i++) {
    var home = homes[i];
    if (!home) continue;
    var settingsPath = path.join(home, ".claude", "settings.json");
    try {
      var changed = mergeHook(settingsPath, command);
      if (changed) installed.push(settingsPath);
    } catch (e) {
      errors.push({ path: settingsPath, error: e && e.message ? e.message : String(e) });
    }
  }
  return { installed: installed, errors: errors };
}

// Pattern shapes Clay used to install in older versions. Listed here so an
// upgrade can strip them from settings.json before re-installing the modern
// list. Without this, users who already had Clay running would end up with
// stale legacy-syntax entries next to the new ones - mostly harmless but
// noisy, and confusing if anyone reads the file.
function isLegacyClayPattern(p) {
  if (typeof p !== "string") return false;
  // Old colon-prefix Bash patterns: Bash(ls:*), Bash(git status:*), etc.
  // Modern patterns use space-asterisk and never contain ":*", so this is
  // a safe identifier for old Clay entries even though it can't tell apart
  // user-authored colon patterns. The risk is judged acceptable because
  // claude flags the colon form as legacy and is phasing it out anyway.
  if (p.indexOf("Bash(") === 0 && p.indexOf(":*)") !== -1) return true;
  return false;
}

// Merge Clay's managed allow-list into permissions.allow without disturbing
// the user's own entries. We identify "ours" by membership in
// CLAY_MANAGED_ALLOW (current) or isLegacyClayPattern (previous shape):
// re-install strips both, then re-inserts the current list. User-authored
// patterns survive unchanged.
function mergeAllowList(settingsPath, patterns) {
  var data = readSettings(settingsPath);
  if (!data.permissions || typeof data.permissions !== "object") data.permissions = {};
  var allow = Array.isArray(data.permissions.allow) ? data.permissions.allow : [];

  var managedSet = {};
  for (var i = 0; i < CLAY_MANAGED_ALLOW.length; i++) managedSet[CLAY_MANAGED_ALLOW[i]] = true;

  // Strip prior Clay-managed entries (current shape + legacy colon shape),
  // then append the fresh list.
  var preserved = allow.filter(function (p) {
    if (managedSet[p]) return false;
    if (isLegacyClayPattern(p)) return false;
    return true;
  });
  var next = preserved.concat(patterns);

  var before = JSON.stringify(allow);
  var after = JSON.stringify(next);
  if (before === after) return false;

  data.permissions.allow = next;
  writeSettings(settingsPath, data);
  return true;
}

/**
 * Install (or refresh) Clay's auto-approve patterns into permissions.allow
 * for one or more user home dirs. Mirrors installNotificationHook's API.
 */
function installAllowList(opts) {
  opts = opts || {};
  var os = require("os");
  var homes = opts.homeDirs && opts.homeDirs.length ? opts.homeDirs : [os.homedir()];
  var patterns = (opts.patterns && opts.patterns.length) ? opts.patterns : CLAY_MANAGED_ALLOW;
  var installed = [];
  var errors = [];
  for (var i = 0; i < homes.length; i++) {
    var home = homes[i];
    if (!home) continue;
    var settingsPath = path.join(home, ".claude", "settings.json");
    try {
      var changed = mergeAllowList(settingsPath, patterns);
      if (changed) installed.push(settingsPath);
    } catch (e) {
      errors.push({ path: settingsPath, error: e && e.message ? e.message : String(e) });
    }
  }
  return { installed: installed, errors: errors };
}

module.exports = {
  installNotificationHook: installNotificationHook,
  installAllowList: installAllowList,
  CLAY_HOOK_MARKER: CLAY_HOOK_MARKER,
  CLAY_MANAGED_ALLOW: CLAY_MANAGED_ALLOW,
};
