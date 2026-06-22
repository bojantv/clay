// Session Context ("Workspace") panel — server side.
//
// Assembles, for the session a client is viewing: the repo + branch, worktree
// status, linked GitHub issues/PRs (auto-detected from the transcript + task
// launcher + manual pins) with their media, the project board URL, the PR for
// the branch (+ preview deploy URL), session-attached images, and the dev
// script + computed port. Also starts/stops a per-project dev server (a PTY
// spawned through the shared terminal manager).
//
// Message types (see ws-schema.js):
//   c2s: workspace_get, workspace_dev_start, workspace_dev_stop,
//        workspace_pin_item, workspace_unpin_item
//   s2c: workspace_state, workspace_dev_status

var gitw = require("./project-workspace-git");
var fs = require("fs");
var path = require("path");

function attachWorkspace(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var getSessionForWs = ctx.getSessionForWs;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var tm = ctx.tm;
  var worktreeMeta = ctx.worktreeMeta || null;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var usersModule = ctx.usersModule;
  var osUsers = ctx.osUsers;
  var persistSession = ctx.persistSession; // (session) => void

  var MAX_ENRICHED = 6;   // cap gh-enriched linked items per request
  var MAX_REFS = 12;      // cap detected refs
  var ITEM_TTL = 60 * 1000;
  var BOARD_TTL = 10 * 60 * 1000;

  // Dev servers keyed by resolved working directory, so the main checkout and
  // each git worktree can run concurrently on their own ports:
  //   resolvedCwd -> { terminalId, port, script, command, branch, startedAt }
  var devServers = {};
  var boardCache = { url: null, at: 0 };
  var itemCache = {}; // "slug#n" -> { data, at }

  function now() { return Date.now(); }

  function slugRepo(repoSlug) {
    return { slug: repoSlug, url: "https://github.com/" + repoSlug };
  }

  // --- GitHub media proxy --------------------------------------------------
  // Private GitHub assets (images/videos in issues/PRs) need GitHub auth that
  // the browser only carries on top-level navigation, so they can't render in
  // an in-app <img>/<video>. We route them through this project's authenticated
  // media proxy (see project-http.js) so everything stays inside the app — no
  // tab switch, no github.com round-trip.
  function isGithubMediaUrl(url) {
    return typeof url === "string"
      && /^https:\/\/(?:[\w.-]*\.githubusercontent\.com|github\.com\/user-attachments\/)/i.test(url);
  }

  function proxyMediaUrl(url) {
    if (!slug || !isGithubMediaUrl(url)) return url;
    return "/p/" + slug + "/api/media?url=" + encodeURIComponent(url);
  }

  // Rewrite displayable (image/video) GitHub media to the in-app proxy, keeping
  // the original URL on `origUrl` for an "open on GitHub" escape hatch. Non-media
  // links and same-origin (clay-hosted) media pass through untouched.
  function proxyMediaList(list) {
    if (!Array.isArray(list)) return list;
    return list.map(function (m) {
      if (m && (m.type === "image" || m.type === "video") && isGithubMediaUrl(m.url)) {
        return { type: m.type, url: proxyMediaUrl(m.url), origUrl: m.url };
      }
      return m;
    });
  }

  // --- Linked-item detection ---------------------------------------------

  var USER_ENTRY = { user_message: 1, user_mention: 1, mention_user: 1 };

  // Two text scopes: everything (for unambiguous URLs) and user-authored
  // messages only (for bare #N — assistant/tool text is full of stray numbers
  // that resolve to unrelated issues on large repos).
  function scanText(session) {
    var all = [];
    var userOnly = [];
    if (session && Array.isArray(session.history)) {
      for (var i = 0; i < session.history.length; i++) {
        var e = session.history[i];
        if (!e) continue;
        var t = (typeof e.text === "string") ? e.text : (typeof e.content === "string") ? e.content : "";
        if (!t) continue;
        all.push(t);
        if (USER_ENTRY[e.type]) userOnly.push(t);
      }
    }
    if (session && session.taskLauncher && session.taskLauncher.itemUrl) all.push(session.taskLauncher.itemUrl);
    return { all: all.join("\n"), user: userOnly.join("\n") };
  }

  function gatherRefs(session, repo) {
    var defaultSlug = repo ? repo.slug : null;
    var refs = [];
    if (session && session.taskLauncher && session.taskLauncher.itemNumber && defaultSlug) {
      refs.push({ slug: defaultSlug, number: session.taskLauncher.itemNumber });
    }
    var text = scanText(session);
    var scanned = gitw.parseUrlRefs(text.all).concat(gitw.parseHashRefs(text.user, defaultSlug));
    for (var i = 0; i < scanned.length; i++) refs.push(scanned[i]);
    if (session && Array.isArray(session.manualLinkedItems)) {
      for (var k = 0; k < session.manualLinkedItems.length; k++) {
        var mp = session.manualLinkedItems[k];
        refs.push({ slug: mp.slug || defaultSlug, number: mp.number, pinned: true });
      }
    }
    var seen = {};
    var out = [];
    for (var r = 0; r < refs.length; r++) {
      var ref = refs[r];
      if (!ref.slug || !ref.number) continue;
      var key = ref.slug + "#" + ref.number;
      if (seen[key]) { if (ref.pinned) seen[key].pinned = true; continue; }
      seen[key] = { slug: ref.slug, number: ref.number, pinned: !!ref.pinned };
      out.push(seen[key]);
    }
    return out.slice(0, MAX_REFS);
  }

  // Resolves the enriched item (full metadata + media), or null if the
  // issue/PR does not exist. Detected references that don't resolve are
  // dropped so the panel never shows a dead link. Negative results are
  // cached too (data: null) to avoid re-probing every refresh.
  function enrichItem(ref, env) {
    return cachedOr(ref, function () { return gitw.fetchItem(cwd, slugRepo(ref.slug), ref.number, env); });
  }

  // Lightweight existence check for overflow refs (no comments/media).
  function verifyItem(ref, env) {
    return cachedOr(ref, function () { return gitw.fetchItemBasic(cwd, slugRepo(ref.slug), ref.number, env); });
  }

  function cachedOr(ref, fetcher) {
    var key = ref.slug + "#" + ref.number;
    var cached = itemCache[key];
    if (cached && (now() - cached.at) < ITEM_TTL) {
      return Promise.resolve(cached.data ? mergeRef(cached.data, ref) : null);
    }
    return fetcher().then(function (data) {
      itemCache[key] = { data: data || null, at: now() };
      if (!data) return null;
      data.slug = ref.slug;
      return mergeRef(data, ref);
    });
  }

  function mergeRef(data, ref) {
    var copy = {};
    for (var k in data) copy[k] = data[k];
    copy.pinned = !!ref.pinned;
    copy.slug = ref.slug;
    return copy;
  }

  // --- Session media ------------------------------------------------------

  function collectSessionMedia(session) {
    var out = [];
    var seen = {};
    if (!session || !Array.isArray(session.history)) return out;
    for (var i = 0; i < session.history.length; i++) {
      var h = hydrateImageRefs(session.history[i]);
      if (h && h.images) {
        for (var j = 0; j < h.images.length; j++) {
          var u = h.images[j].url;
          if (seen[u]) continue;
          seen[u] = true;
          out.push({ url: u, type: "image", mediaType: h.images[j].mediaType });
        }
      }
    }
    return out;
  }

  // --- Dev server ---------------------------------------------------------

  // The worktree a session is actively editing in (set by session-worktree.js
  // from the agent's file edits), validated to still exist on disk. null means
  // the session is working in the project's main checkout.
  function activeWtFor(session) {
    var aw = session && session.activeWorktree;
    if (!aw || !aw.devCwd) return null;
    try { if (!fs.existsSync(aw.devCwd)) return null; } catch (e) { return null; }
    return aw;
  }

  // The live dev server we started for a directory, if still running. Reaps the
  // map entry when its terminal is gone.
  function liveServerFor(dirAbs) {
    var s = devServers[dirAbs];
    if (s && tm.has(s.terminalId)) return s;
    if (s) delete devServers[dirAbs];
    return null;
  }

  // Pick a port for a new dev server: basePort for the main checkout, basePort+1
  // for a worktree (so they coexist), then bump past any port already claimed by
  // another Clay dev server in this project.
  function allocPort(aw, basePort) {
    if (!basePort) return basePort;
    var p = (aw || worktreeMeta) ? basePort + 1 : basePort;
    var used = {};
    Object.keys(devServers).forEach(function (k) {
      if (devServers[k] && devServers[k].port) used[devServers[k].port] = 1;
    });
    while (used[p]) p++;
    return p;
  }

  // Dev-server status for the directory THIS session is bound to (its worktree,
  // or the main checkout). Each directory has its own independent server.
  function devStatusPayload(session, cb) {
    var aw = activeWtFor(session);
    var boundCwd = aw ? aw.devCwd : cwd;
    var boundAbs = path.resolve(boundCwd);
    var det = gitw.detectDev(boundCwd);

    var server = liveServerFor(boundAbs);
    var running = !!server;
    // A running server knows its real port; otherwise show the port one would
    // get if started now.
    var port = server ? server.port : (det ? allocPort(aw, det.basePort) : null);

    gitw.probePort(port, function (live) {
      // external = something is listening on the port that Clay didn't start
      // (e.g. `yarn dev` in another window).
      var external = !running && live && !!port;
      var status = running ? (live ? "running" : "starting") : (external ? "external" : "stopped");
      cb({
        type: "workspace_dev_status",
        running: running,
        portLive: live,
        external: external,
        status: status,
        port: port,
        branch: aw ? aw.branch : null,
        terminalId: server ? server.terminalId : null,
        script: det ? det.script : null,
      });
    });
  }

  // Targeted, session-accurate status for one client.
  function sendDevStatusTo(ws) {
    devStatusPayload(getSessionForWs(ws), function (p) { sendTo(ws, p); });
  }

  // Global (session-agnostic) broadcast — used when no client is in scope, e.g.
  // the dev server exits. Per-session views self-correct on their next poll.
  function broadcastDevStatus() {
    devStatusPayload(null, function (p) { send(p); });
  }

  // --- workspace_get ------------------------------------------------------

  // Resolve the board URL (cached).
  function resolveBoard(repo, env) {
    if (!repo) return Promise.resolve(null);
    if (boardCache.url && (now() - boardCache.at) < BOARD_TTL) return Promise.resolve(boardCache.url);
    return gitw.getBoardUrl(cwd, repo, env).then(function (url) {
      boardCache = { url: url, at: now() };
      return url;
    });
  }

  // Resolve the PR for the branch (+ its media/preview).
  function resolvePr(repo, branch, env) {
    if (!repo || !branch) return Promise.resolve(null);
    return gitw.findPrForBranch(cwd, repo, branch, env).then(function (prRaw) {
      if (!prRaw) return null;
      return enrichItem({ slug: repo.slug, number: prRaw.number }, env).then(function (prItem) {
        return {
          number: prRaw.number,
          url: prRaw.url,
          title: prRaw.title,
          state: prRaw.state,
          previewUrl: prItem ? prItem.previewUrl : null,
          media: prItem ? prItem.media : [],
        };
      });
    });
  }

  function buildState(session, cb) {
    var repo = gitw.getRepo(cwd);
    var env = gitw.ghEnvFor(cwd);
    var refs = gatherRefs(session, repo);

    // Bind the panel to the worktree this session is actually editing in, if
    // any — otherwise the project's main checkout.
    var aw = activeWtFor(session);
    var mainBranch = gitw.getBranch(cwd);
    var branch = aw ? aw.branch : mainBranch;
    var devBaseCwd = aw ? aw.devCwd : cwd;

    var dev = null;
    var det = gitw.detectDev(devBaseCwd);
    if (det) {
      // Initial port for display; the status fold below replaces it with the
      // running server's actual port when one exists.
      var port = allocPort(aw, det.basePort);
      dev = { script: det.script, command: det.command, port: port, localUrl: port ? "http://localhost:" + port : null };
    }

    // Validate + enrich every detected reference concurrently. The first
    // MAX_ENRICHED get full metadata + media; the rest get a cheap existence
    // check. Either way, refs that don't resolve to a real issue/PR drop out.
    var itemPromises = refs.map(function (ref, i) {
      return i < MAX_ENRICHED ? enrichItem(ref, env) : verifyItem(ref, env);
    });

    Promise.all([
      resolveBoard(repo, env),
      resolvePr(repo, branch, env),
      Promise.all(itemPromises),
    ]).then(function (res) {
      var state = {
        type: "workspace_state",
        sessionId: session ? session.localId : null,
        repo: repo ? { slug: repo.slug, url: repo.url } : null,
        branch: branch,
        worktree: aw
          ? { isWorktree: true, active: true, branch: aw.branch, root: aw.root, mainBranch: mainBranch }
          : (worktreeMeta
              ? { isWorktree: true, parentSlug: worktreeMeta.parentSlug, branch: worktreeMeta.branch, accessible: worktreeMeta.accessible }
              : { isWorktree: false }),
        board: res[0],
        pr: res[1],
        items: res[2].filter(Boolean),
        truncatedItems: 0,
        sessionMedia: collectSessionMedia(session),
        dev: dev,
      };
      // Route GitHub-hosted media through the in-app proxy so it renders in the
      // panel without a github.com round-trip.
      if (state.pr && state.pr.media) state.pr.media = proxyMediaList(state.pr.media);
      for (var ii = 0; ii < state.items.length; ii++) {
        if (state.items[ii] && state.items[ii].media) state.items[ii].media = proxyMediaList(state.items[ii].media);
      }
      // Fold in live dev-server status for the bound directory.
      devStatusPayload(session, function (st) {
        if (state.dev) {
          state.dev.status = st.status;
          state.dev.running = st.running;
          state.dev.portLive = st.portLive;
          state.dev.external = st.external;
          state.dev.branch = aw ? aw.branch : null;
          if (st.port) { state.dev.port = st.port; state.dev.localUrl = "http://localhost:" + st.port; }
          state.dev.terminalId = st.terminalId;
        }
        cb(state);
      });
    }).catch(function (e) {
      cb({ type: "workspace_state", error: "Failed to load workspace context: " + (e && e.message || e) });
    });
  }

  // --- Message handler ----------------------------------------------------

  function canUseTerminal(ws) {
    if (ws && ws._clayUser && usersModule && typeof usersModule.getEffectivePermissions === "function") {
      var perms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
      if (!perms.terminal) return false;
    }
    return true;
  }

  function handleWorkspaceMessage(ws, msg) {
    if (msg.type === "workspace_get") {
      var session = getSessionForWs(ws);
      buildState(session, function (state) { sendTo(ws, state); });
      return true;
    }

    if (msg.type === "workspace_dev_status_get") {
      // Lightweight poll: just the dev-server status (no GitHub round-trips).
      // Lets the panel notice servers started/stopped outside Clay, and stay
      // bound to the worktree this session is editing in.
      sendDevStatusTo(ws);
      return true;
    }

    if (msg.type === "workspace_dev_start") {
      if (!canUseTerminal(ws)) {
        sendTo(ws, { type: "workspace_dev_status", running: false, error: "Terminal access is not permitted" });
        return true;
      }
      // Bind the dev server to the worktree this session is editing in (or the
      // main checkout). Each directory gets its own server, so starting a
      // worktree preview never disturbs the main checkout's.
      var startSession = getSessionForWs(ws);
      var startAw = activeWtFor(startSession);
      var runCwd = startAw ? startAw.devCwd : cwd;
      var runAbs = path.resolve(runCwd);
      // Already serving this exact directory → just report status.
      if (liveServerFor(runAbs)) {
        sendDevStatusTo(ws);
        return true;
      }
      var det = gitw.detectDev(runCwd);
      if (!det) {
        sendTo(ws, { type: "workspace_dev_status", running: false, error: "No dev script found in package.json" });
        return true;
      }
      var port = allocPort(startAw, det.basePort);
      var command = (port ? "PORT=" + port + " " : "") + det.command;
      var t = tm.create(msg.cols || 120, msg.rows || 30, getOsUserInfoForWs(ws), ws, {
        kind: "dev-server",
        title: "dev:" + (port || det.script),
        initialInput: command + "\n",
        cwd: runCwd,
        onExit: function () { delete devServers[runAbs]; broadcastDevStatus(); },
      });
      if (!t) {
        sendTo(ws, { type: "workspace_dev_status", running: false, error: "Cannot spawn dev server (node-pty unavailable or terminal limit reached)" });
        return true;
      }
      devServers[runAbs] = {
        terminalId: t.id, port: port, script: det.script, command: command,
        cwd: runCwd, branch: startAw ? startAw.branch : gitw.getBranch(cwd), startedAt: now(),
      };
      send({ type: "term_list", terminals: tm.list() });
      sendDevStatusTo(ws);
      return true;
    }

    if (msg.type === "workspace_dev_stop") {
      // Stop the server for the directory this session is bound to.
      var stopSession = getSessionForWs(ws);
      var stopAw = activeWtFor(stopSession);
      var stopAbs = path.resolve(stopAw ? stopAw.devCwd : cwd);
      var stopServer = liveServerFor(stopAbs);
      if (stopServer) {
        tm.close(stopServer.terminalId);
        delete devServers[stopAbs];
        send({ type: "term_list", terminals: tm.list() });
      }
      sendDevStatusTo(ws);
      return true;
    }

    if (msg.type === "workspace_pin_item" || msg.type === "workspace_unpin_item") {
      var sess = getSessionForWs(ws);
      if (!sess) return true;
      var repo = gitw.getRepo(cwd);
      var slug = msg.slug || (repo ? repo.slug : null);
      var number = parseInt(msg.number, 10);
      if (!slug || !number) { sendTo(ws, { type: "workspace_state", error: "Invalid issue reference" }); return true; }
      if (!Array.isArray(sess.manualLinkedItems)) sess.manualLinkedItems = [];
      var idx = -1;
      for (var i = 0; i < sess.manualLinkedItems.length; i++) {
        var it = sess.manualLinkedItems[i];
        if (it.slug === slug && it.number === number) { idx = i; break; }
      }
      if (msg.type === "workspace_pin_item") {
        if (idx === -1) sess.manualLinkedItems.push({ slug: slug, number: number });
      } else if (idx !== -1) {
        sess.manualLinkedItems.splice(idx, 1);
      }
      if (typeof persistSession === "function") { try { persistSession(sess); } catch (e) {} }
      buildState(sess, function (state) { sendTo(ws, state); });
      return true;
    }

    return false;
  }

  return {
    handleWorkspaceMessage: handleWorkspaceMessage,
  };
}

module.exports = { attachWorkspace: attachWorkspace };
