// git-accounts.js — per-project GitHub account pinning.
//
// Lists the GitHub accounts logged into the `gh` CLI and pins a project's git
// credentials to a chosen account via a repo-local credential helper. The
// helper runs `gh auth token --user <account>`, so git always authenticates as
// that account regardless of which account `gh` has globally active. Clearing
// the pin lets the repo fall back to the global default.

var { execFileSync, execSync } = require("child_process");

var GH_HOST = "github.com";
var HELPER_KEY = "credential.https://" + GH_HOST + ".helper";

// `gh auth status` writes to stderr on older gh and stdout on newer; capture
// both via a merged-output shell read (static command, no interpolation).
function ghStatusText() {
  try {
    return execSync("gh auth status 2>&1", { encoding: "utf8" });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

function listGitHubAccounts() {
  var accounts = [];
  var text = ghStatusText();
  var re = /account ([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (accounts.indexOf(m[1]) === -1) accounts.push(m[1]);
  }
  return accounts;
}

function helperValue(account) {
  // Repo-local credential helper: always authenticate as <account> via a gh
  // token, independent of the globally-active gh account.
  return '!f() { test "$1" = get && printf "username=' + account +
    '\\npassword=%s\\n" "$(gh auth token --user ' + account + ')"; }; f';
}

function isGitRepo(projectPath) {
  try {
    execFileSync("git", ["-C", projectPath, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

// Pin (account set) or clear (account falsy) the project's repo-local helper.
function applyProjectGitAccount(projectPath, account) {
  if (!projectPath) return { ok: false, error: "Missing project path" };
  if (!isGitRepo(projectPath)) return { ok: false, error: "Not a git repository" };
  try {
    // Always clear any existing local helper for this host first.
    try {
      execFileSync("git", ["-C", projectPath, "config", "--local", "--unset-all", HELPER_KEY], { stdio: "ignore" });
    } catch (e) {}
    if (account) {
      // Empty sentinel resets inherited (global/system) helpers, then pin.
      execFileSync("git", ["-C", projectPath, "config", "--local", "--add", HELPER_KEY, ""], { stdio: "ignore" });
      execFileSync("git", ["-C", projectPath, "config", "--local", "--add", HELPER_KEY, helperValue(account)], { stdio: "ignore" });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Best-effort read of the account currently pinned in the repo-local helper.
function getProjectGitAccount(projectPath) {
  if (!projectPath || !isGitRepo(projectPath)) return null;
  try {
    var out = execFileSync(
      "git",
      ["-C", projectPath, "config", "--local", "--get-all", HELPER_KEY],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    var m = /gh auth token --user ([A-Za-z0-9-]+)/.exec(out);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

module.exports = {
  listGitHubAccounts: listGitHubAccounts,
  applyProjectGitAccount: applyProjectGitAccount,
  getProjectGitAccount: getProjectGitAccount,
};
