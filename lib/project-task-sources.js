var { execFileSync } = require("child_process");
var gitAccounts = require("./git-accounts");

// Resolve which gh account to fetch issues as. Priority:
//   1. explicit per-call override (args.ghAccount)
//   2. recipe override (source.ghAccount)
//   3. the project's pinned GitHub account (Project Settings → GitHub account)
//   4. the account git would actually authenticate as for this repo
// Falling through to "" means "use whatever gh account is currently active".
function resolveGhAccount(cwd, recipe, args) {
  var source = (recipe && recipe.source) || {};
  if (args && args.ghAccount) return args.ghAccount;
  if (source.ghAccount) return source.ghAccount;
  try {
    var pinned = gitAccounts.getProjectGitAccount(cwd);
    if (pinned) return pinned;
  } catch (e) {}
  try {
    var resolved = gitAccounts.resolveProjectGitAccount(cwd);
    if (resolved) return resolved;
  } catch (e) {}
  return "";
}

// Build the env for gh calls. When the recipe pins a gh account, force that
// account's token via GH_TOKEN so issue fetching is independent of whichever
// account is currently active (the user may switch accounts for PRs, etc.).
function ghEnv(cwd, account) {
  if (!account) return process.env;
  try {
    var token = execFileSync("gh", ["auth", "token", "--user", account], {
      cwd: cwd,
      encoding: "utf8",
    }).trim();
    if (token) return Object.assign({}, process.env, { GH_TOKEN: token });
  } catch (e) {
    // Fall back to the active account if the pinned one is unavailable.
  }
  return process.env;
}

function execGh(cwd, args, env) {
  var out = execFileSync("gh", args, {
    cwd: cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
    env: env || process.env,
  });
  return JSON.parse(out);
}

function ghLogin(cwd, env) {
  try {
    var user = execGh(cwd, ["api", "user"], env);
    return user && user.login ? user.login : null;
  } catch (e) {
    return null;
  }
}

function labelNames(issue) {
  var labels = issue && issue.labels ? issue.labels : [];
  var names = [];
  for (var i = 0; i < labels.length; i++) {
    names.push(String(labels[i].name || labels[i]).toLowerCase());
  }
  return names;
}

function hasLabel(names, label) {
  var wanted = String(label || "").toLowerCase();
  if (!wanted) return false;
  return names.indexOf(wanted) !== -1;
}

// Looser match for exclusions: a label matches a token if it equals it, starts
// with "<token><separator>" (e.g. "BE-api", "backend:foo"), or — for tokens of
// 4+ chars — contains it as a substring. This mirrors TRIAGE.local.md's
// "label containing BE or backend" while avoiding false positives on short
// tokens like "BE" matching unrelated words ("beta").
function labelMatchesToken(name, token) {
  name = String(name || "").toLowerCase();
  token = String(token || "").toLowerCase();
  if (!token) return false;
  if (name === token) return true;
  var seps = ["-", ":", " ", "/"];
  for (var i = 0; i < seps.length; i++) {
    if (name.indexOf(token + seps[i]) === 0) return true;
  }
  if (token.length >= 4 && name.indexOf(token) !== -1) return true;
  return false;
}

function anyLabelMatchesToken(names, token) {
  for (var i = 0; i < names.length; i++) {
    if (labelMatchesToken(names[i], token)) return true;
  }
  return false;
}

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(",").map(function (v) { return v.trim(); }).filter(function (v) { return !!v; });
}

function issueAssignedTo(issue, assignee) {
  if (!assignee || assignee === "any") return true;
  var list = issue.assignees || [];
  for (var i = 0; i < list.length; i++) {
    var login = list[i] && (list[i].login || list[i].name);
    if (login === assignee) return true;
  }
  return false;
}

function issueMatches(recipe, args, issue, currentLogin) {
  var filter = recipe.filter || {};
  var names = labelNames(issue);
  var skipStatuses = args.issue ? [] : splitList(args.skipStatus || filter.skipProjectStatuses);
  var projectItems = issue.projectItems || [];
  for (var ps = 0; ps < projectItems.length; ps++) {
    var statusName = projectItems[ps] && projectItems[ps].status && projectItems[ps].status.name;
    for (var ss = 0; ss < skipStatuses.length; ss++) {
      if (statusName && statusName.toLowerCase() === String(skipStatuses[ss]).toLowerCase()) return false;
    }
  }
  // Allow-list of project statuses: when set, the issue must currently sit in one
  // of these statuses (e.g. only "Backlog" or "Dev Complete", never "In Progress").
  var includeStatuses = args.issue ? [] : splitList(args.onlyStatus || filter.includeProjectStatuses);
  if (includeStatuses.length > 0) {
    var statusMatched = false;
    for (var ips = 0; ips < projectItems.length; ips++) {
      var pStatus = projectItems[ips] && projectItems[ips].status && projectItems[ips].status.name;
      if (!pStatus) continue;
      for (var is = 0; is < includeStatuses.length; is++) {
        if (pStatus.toLowerCase() === String(includeStatuses[is]).toLowerCase()) { statusMatched = true; break; }
      }
      if (statusMatched) break;
    }
    if (!statusMatched) return false;
  }
  var titleExcludePrefixes = splitList(filter.titleExcludePrefixes);
  var issueTitle = String(issue.title || "").toLowerCase();
  for (var tp = 0; tp < titleExcludePrefixes.length; tp++) {
    var prefix = String(titleExcludePrefixes[tp] || "").toLowerCase();
    if (prefix && issueTitle.indexOf(prefix) === 0) return false;
  }
  var assigned = args.assigned || filter.assigned || "";
  if (assigned === "me") assigned = currentLogin || "";
  if (assigned && !issueAssignedTo(issue, assigned)) return false;

  var include = splitList(args.label || args.include || (filter.labels && filter.labels.include));
  for (var i = 0; i < include.length; i++) {
    if (!hasLabel(names, include[i])) return false;
  }

  var exclude = splitList(args.exclude || (filter.labels && filter.labels.exclude));
  for (var ex = 0; ex < exclude.length; ex++) {
    if (anyLabelMatchesToken(names, exclude[ex])) return false;
  }

  var type = args.type || filter.type || "";
  if (type === "bug") {
    if (hasLabel(names, "feature") || hasLabel(names, "legacy")) return false;
    if (filter.requireBugLabel && !hasLabel(names, "bug")) return false;
  }
  if (type === "feature" && !hasLabel(names, "feature")) return false;
  if (type === "legacy" && !hasLabel(names, "legacy")) return false;
  return true;
}

function githubIssues(cwd, recipe, args) {
  var source = recipe.source || {};
  var repo = args.repo || source.repo;
  if (!repo) throw new Error("Recipe is missing source.repo");
  var account = resolveGhAccount(cwd, recipe, args);
  var env = ghEnv(cwd, account);
  var currentLogin = ghLogin(cwd, env);
  if (args.issue) {
    var issue = execGh(cwd, [
      "issue", "view", String(args.issue),
      "--repo", repo,
      "--json", "number,title,url,body,labels,assignees,state,projectItems",
    ], env);
    return [issue];
  }
  var state = args.state || (recipe.filter && recipe.filter.state) || "open";
  var limit = parseInt(args.fetch || (recipe.source && recipe.source.fetchLimit) || 100, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  var listArgs = [
    "issue", "list",
    "--repo", repo,
    "--state", state,
    "--limit", String(limit),
    "--json", "number,title,url,body,labels,assignees,state,projectItems",
  ];
  // Filter by assignee server-side so we don't miss assigned issues that fall
  // outside the newest `limit` results in large repos. `gh` accepts @me.
  var assignee = args.assigned || (recipe.filter && recipe.filter.assigned) || "";
  if (assignee && assignee !== "any") {
    listArgs.push("--assignee", assignee === "me" ? "@me" : assignee);
  }
  var issues = execGh(cwd, listArgs, env);
  var out = [];
  for (var i = 0; i < issues.length; i++) {
    if (issueMatches(recipe, args, issues[i], currentLogin)) out.push(issues[i]);
  }
  return out;
}

function fetchItems(cwd, recipe, args) {
  var source = recipe.source || {};
  if (source.provider === "github" && (!source.kind || source.kind === "issue" || source.kind === "issues")) {
    return githubIssues(cwd, recipe, args);
  }
  throw new Error("Unsupported task source: " + (source.provider || "unknown"));
}

module.exports = {
  fetchItems: fetchItems,
};
