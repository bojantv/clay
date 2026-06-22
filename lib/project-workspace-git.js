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

// Scan free text for issue/PR references. Returns [{ slug, number }].
// Recognizes full github.com issue/pull URLs (any repo) and bare #NNN
// (resolved against the current repo's slug).
function parseIssueRefs(text, defaultSlug) {
  var refs = [];
  var seen = {};
  function add(slug, number) {
    if (!slug || !number) return;
    var key = slug + "#" + number;
    if (seen[key]) return;
    seen[key] = true;
    refs.push({ slug: slug, number: number });
  }
  var re = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g;
  var m;
  while ((m = re.exec(text))) add(m[1], parseInt(m[2], 10));
  if (defaultSlug) {
    re = /(?:^|[\s(])#(\d{1,7})\b/g;
    while ((m = re.exec(text))) add(defaultSlug, parseInt(m[1], 10));
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

module.exports = {
  ghEnvFor: ghEnvFor,
  getRepo: getRepo,
  getBranch: getBranch,
  getBoardUrl: getBoardUrl,
  findPrForBranch: findPrForBranch,
  fetchItem: fetchItem,
  extractMedia: extractMedia,
  extractPreviewUrl: extractPreviewUrl,
  parseIssueRefs: parseIssueRefs,
  detectDev: detectDev,
  probePort: probePort,
};
