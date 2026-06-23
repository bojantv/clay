// Pure helpers for the Session Context ("Workspace") panel: git/gh repo + branch
// + PR + board detection, GitHub issue/PR media extraction, package.json dev
// script + port detection, and a TCP port liveness probe.
//
// No project context here — everything takes an explicit cwd. The stateful
// message handlers live in project-workspace.js.

var { execFileSync, execFile } = require("child_process");
var fs = require("fs");
var path = require("path");
var net = require("net");
var taskSources = require("./project-task-sources");

// Run a git command, returning trimmed stdout or "" on any failure.
// Local git reads are fast, so these stay synchronous.
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd: cwd, encoding: "utf8", timeout: 5000 }).trim();
  } catch (e) {
    return "";
  }
}

// Run a gh command and JSON-parse stdout, resolving null on any failure.
// ASYNC (execFile, not execFileSync) so network-bound gh calls never block
// the daemon's event loop.
function ghJsonAsync(cwd, args, env) {
  return new Promise(function (resolve) {
    execFile("gh", args, {
      cwd: cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15000,
      env: env || process.env,
    }, function (err, stdout) {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
}

// Build a gh env scoped to the project's pinned GitHub account.
function ghEnvFor(cwd) {
  try {
    return taskSources.ghEnv(cwd, taskSources.resolveGhAccount(cwd, null, {}));
  } catch (e) {
    return process.env;
  }
}

// Parse the origin remote into { owner, repo, slug, url }. Supports both
// git@github.com:owner/repo.git and https://github.com/owner/repo(.git) forms.
function getRepo(cwd) {
  var url = git(cwd, ["config", "--get", "remote.origin.url"]);
  if (!url) return null;
  var m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  var owner = m[1];
  var repo = m[2];
  return { owner: owner, repo: repo, slug: owner + "/" + repo, url: "https://github.com/" + owner + "/" + repo };
}

function getBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || null;
}

// Find the project's first Projects-v2 board URL via the GraphQL API.
function getBoardUrl(cwd, repo, env) {
  if (!repo) return Promise.resolve(null);
  var q = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:1){nodes{url}}}}";
  return ghJsonAsync(cwd, ["api", "graphql", "-f", "query=" + q, "-F", "owner=" + repo.owner, "-F", "name=" + repo.repo], env).then(function (data) {
    try {
      var nodes = data.data.repository.projectsV2.nodes;
      if (nodes && nodes.length) return nodes[0].url;
    } catch (e) {}
    return null;
  });
}

// Find an open PR whose head branch matches `branch`.
function findPrForBranch(cwd, repo, branch, env) {
  if (!repo || !branch) return Promise.resolve(null);
  return ghJsonAsync(cwd, [
    "pr", "list", "--repo", repo.slug, "--head", branch, "--state", "all",
    "--json", "number,url,title,state", "--limit", "1",
  ], env).then(function (arr) {
    return (arr && arr.length) ? arr[0] : null;
  });
}

// Extract image/video/attachment URLs from issue/PR markdown (body + comments).
function extractMedia(text) {
  if (!text) return [];
  var out = [];
  var seen = {};
  function add(url) {
    if (!url || seen[url]) return;
    seen[url] = true;
    var type = "link";
    if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url)) type = "image";
    else if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) type = "video";
    out.push({ url: url, type: type });
  }
  var re;
  // Markdown images: ![alt](url)
  re = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  var mm;
  while ((mm = re.exec(text))) add(mm[1]);
  // HTML <img src=...> and <video>/<source src=...>
  re = /<(?:img|source|video)[^>]+src=["']([^"']+)["']/gi;
  while ((mm = re.exec(text))) add(mm[1]);
  // Bare GitHub-hosted media/attachment URLs
  re = /https?:\/\/(?:user-images\.githubusercontent\.com|github\.com\/user-attachments\/assets|[\w.-]*githubusercontent\.com)\/[^\s)"'<>]+/gi;
  while ((mm = re.exec(text))) add(mm[0]);
  return out;
}

// Find the first known deploy/preview URL in arbitrary text.
function extractPreviewUrl(text) {
  if (!text) return null;
  var m = text.match(/https?:\/\/[^\s)"'<>]*(?:pages\.dev|vercel\.app|netlify\.app|onrender\.com|fly\.dev)[^\s)"'<>]*/i);
  return m ? m[0] : null;
}

// Fetch one issue/PR: title, state, type, labels, media + preview URL from
// the body and comments. ASYNC — resolves the item object, or null on failure.
function fetchItem(cwd, repo, number, env) {
  if (!repo || !number) return Promise.resolve(null);
  return Promise.all([
    ghJsonAsync(cwd, ["api", "repos/" + repo.slug + "/issues/" + number], env),
    ghJsonAsync(cwd, ["api", "repos/" + repo.slug + "/issues/" + number + "/comments?per_page=100"], env),
  ]).then(function (res) {
    var data = res[0];
    var comments = res[1];
    if (!data) return null;
    var isPr = !!data.pull_request;
    var allText = data.body || "";
    var media = extractMedia(data.body || "");
    if (Array.isArray(comments)) {
      for (var i = 0; i < comments.length; i++) {
        allText += "\n" + (comments[i].body || "");
        var cm = extractMedia(comments[i].body || "");
        for (var j = 0; j < cm.length; j++) media.push(cm[j]);
      }
    }
    var seen = {};
    var dedupMedia = [];
    for (var k = 0; k < media.length; k++) {
      if (seen[media[k].url]) continue;
      seen[media[k].url] = true;
      dedupMedia.push(media[k]);
    }
    return {
      number: number,
      type: isPr ? "pr" : "issue",
      title: data.title || "",
      state: data.state || "",
      url: data.html_url || (repo.url + "/issues/" + number),
      labels: (data.labels || []).map(function (l) { return typeof l === "string" ? l : l.name; }),
      media: dedupMedia,
      previewUrl: extractPreviewUrl(allText),
    };
  });
}

// Lightweight existence check + basic metadata (no comments/media). Resolves
// the item, or null if the issue/PR does not exist or isn't accessible. Used
// to validate detected references so dead links are never shown.
function fetchItemBasic(cwd, repo, number, env) {
  if (!repo || !number) return Promise.resolve(null);
  return ghJsonAsync(cwd, ["api", "repos/" + repo.slug + "/issues/" + number], env).then(function (data) {
    if (!data || !data.number) return null;
    var isPr = !!data.pull_request;
    return {
      number: number,
      type: isPr ? "pr" : "issue",
      title: data.title || "",
      state: data.state || "",
      url: data.html_url || (repo.url + "/issues/" + number),
      labels: (data.labels || []).map(function (l) { return typeof l === "string" ? l : l.name; }),
      media: [],
      previewUrl: null,
    };
  });
}

// Full github.com issue/pull URLs (any repo). These are unambiguous, so they
// can be harvested from anywhere — assistant output, pasted links, etc.
function parseUrlRefs(text) {
  var refs = [];
  var seen = {};
  var re = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g;
  var m;
  while ((m = re.exec(text))) {
    var key = m[1] + "#" + m[2];
    if (seen[key]) continue;
    seen[key] = true;
    refs.push({ slug: m[1], number: parseInt(m[2], 10) });
  }
  return refs;
}

// Bare #NNN / "issue NNN" / "PR NNN" references against the current repo.
// CALLERS SHOULD ONLY PASS USER-AUTHORED TEXT: a bare number in assistant
// output or a tool result (diffs, logs, lists) is almost never a real
// reference, and on large repos low numbers always resolve to *something*.
//
// Words that, when they immediately precede "#N", mean it is NOT a GitHub
// issue/PR reference — e.g. "React error #185", "project #4", "step #3".
var HASH_STOP_WORDS = /(?:error|errors|project|projects|board|boards|step|steps|page|pages|line|lines|col|cols|column|columns|version|ver|item|items|figure|fig|note|notes|ref|refs|port|ports|chapter|section|sections|react|node|index|priority|rank|row|rows|table|test|tests)$/i;

function parseHashRefs(text, slug) {
  var refs = [];
  var seen = {};
  if (!slug || !text) return refs;
  function add(n) {
    n = parseInt(n, 10);
    if (!n || seen[n]) return;
    seen[n] = true;
    refs.push({ slug: slug, number: n });
  }
  var m;
  // Explicit keyword references are unambiguous: "issue 1500", "PR #1908".
  var reKw = /\b(?:issues?|prs?|pull(?:\s+request)?)\s+#?(\d{1,7})\b/gi;
  while ((m = reKw.exec(text))) add(m[1]);
  // Bare "#N" — only when the immediately-preceding word doesn't signal a
  // non-issue meaning (error code, board/project number, step, page, ...).
  var reHash = /([A-Za-z]+)?\s*#(\d{1,7})\b/g;
  while ((m = reHash.exec(text))) {
    if (m[1] && HASH_STOP_WORDS.test(m[1])) continue;
    add(m[2]);
  }
  return refs;
}

// Detect the dev script + base port from the project's package.json.
// Returns { script, command, basePort } or null when no runnable script.
function detectDev(cwd) {
  var pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch (e) {
    return null;
  }
  var scripts = (pkg && pkg.scripts) || {};
  var name = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : null;
  if (!name) return null;
  var body = String(scripts[name] || "");
  var manager = fs.existsSync(path.join(cwd, "yarn.lock")) ? "yarn" :
    fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  var command = manager === "npm" ? "npm run " + name : manager + " " + name;

  var basePort = null;
  var pm = body.match(/(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/i);
  if (pm) basePort = parseInt(pm[1], 10);
  if (!basePort) {
    // Fall back to a .envrc / .env PORT declaration.
    for (var fi = 0; fi < 2; fi++) {
      try {
        var ev = fs.readFileSync(path.join(cwd, fi === 0 ? ".envrc" : ".env"), "utf8");
        var em = ev.match(/(?:^|\n)\s*(?:export\s+)?PORT\s*=\s*(\d{2,5})/);
        if (em) { basePort = parseInt(em[1], 10); break; }
      } catch (e) {}
    }
  }
  // Many dev scripts are a bare runner (e.g. "vite") with the port set in the
  // tool's config file instead. Read those before falling back to defaults.
  if (!basePort && /\bvite\b/.test(body)) basePort = readConfigPort(cwd, ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs", "vite.config.mts", "vite.config.cts"]);
  if (!basePort) {
    if (/\bnext\b/.test(body)) basePort = 3000;
    else if (/\bvite\b/.test(body)) basePort = 5173;
    else if (/\bastro\b/.test(body)) basePort = 4321;
    else if (/\bnuxt\b/.test(body)) basePort = 3000;
    else if (/ng serve|angular/.test(body)) basePort = 4200;
    else if (/vue-cli-service|\bvue\b/.test(body)) basePort = 8080;
    else basePort = 3000;
  }
  return { script: name, command: command, basePort: basePort };
}

// Read `server: { port: NNNN }` from the first matching config file. Returns
// the port number or null. Best-effort regex (no JS evaluation): finds the
// first `port:` inside a `server` block.
function readConfigPort(cwd, files) {
  for (var i = 0; i < files.length; i++) {
    var text;
    try { text = fs.readFileSync(path.join(cwd, files[i]), "utf8"); } catch (e) { continue; }
    var m = text.match(/server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// True if something is already listening on 127.0.0.1:port.
function probePort(port, cb) {
  if (!port) return cb(false);
  var done = false;
  function finish(v) { if (!done) { done = true; cb(v); } }
  var sock = net.connect({ host: "127.0.0.1", port: port }, function () {
    sock.destroy();
    finish(true);
  });
  sock.setTimeout(800);
  sock.on("timeout", function () { sock.destroy(); finish(false); });
  sock.on("error", function () { finish(false); });
}

// Kill whatever process is listening on the given TCP port (best effort).
// Used by "Re-run here" to take over a port held by a process Clay didn't
// start — e.g. a different project's dev server, or a stale one. Calls back
// with true if at least one PID was signalled.
function killPort(port, cb) {
  if (!port) return cb(false);
  execFile("lsof", ["-ti", "tcp:" + port, "-sTCP:LISTEN"], { timeout: 5000 }, function (err, stdout) {
    var pids = String(stdout || "").split(/\s+/).filter(Boolean);
    if (!pids.length) return cb(false);
    pids.forEach(function (pid) {
      try { process.kill(parseInt(pid, 10), "SIGTERM"); } catch (e) {}
    });
    cb(true);
  });
}

module.exports = {
  ghEnvFor: ghEnvFor,
  getRepo: getRepo,
  getBranch: getBranch,
  getBoardUrl: getBoardUrl,
  findPrForBranch: findPrForBranch,
  fetchItem: fetchItem,
  fetchItemBasic: fetchItemBasic,
  extractMedia: extractMedia,
  extractPreviewUrl: extractPreviewUrl,
  parseUrlRefs: parseUrlRefs,
  parseHashRefs: parseHashRefs,
  detectDev: detectDev,
  probePort: probePort,
  killPort: killPort,
};
