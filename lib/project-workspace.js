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

function attachWorkspace(ctx) {
  var cwd = ctx.cwd;
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

  // Single dev server per project: { terminalId, port, script, command, startedAt }
  var devServer = null;
  var boardCache = { url: null, at: 0 };
  var itemCache = {}; // "slug#n" -> { data, at }

  function now() { return Date.now(); }

  function slugRepo(slug) {
    return { slug: slug, url: "https://github.com/" + slug };
  }

  // --- Linked-item detection ---------------------------------------------

  function transcriptText(session) {
    var parts = [];
    if (session && Array.isArray(session.history)) {
      for (var i = 0; i < session.history.length; i++) {
        var e = session.history[i];
        if (!e) continue;
        if (typeof e.text === "string") parts.push(e.text);
        if (typeof e.content === "string") parts.push(e.content);
      }
    }
    if (session && session.taskLauncher && session.taskLauncher.itemUrl) parts.push(session.taskLauncher.itemUrl);
    return parts.join("\n");
  }

  function gatherRefs(session, repo) {
    var defaultSlug = repo ? repo.slug : null;
    var refs = [];
    if (session && session.taskLauncher && session.taskLauncher.itemNumber && defaultSlug) {
      refs.push({ slug: defaultSlug, number: session.taskLauncher.itemNumber });
    }
    var scanned = gitw.parseIssueRefs(transcriptText(session), defaultSlug);
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

  function desiredPort(basePort) {
    if (!basePort) return basePort;
    return worktreeMeta ? basePort + 1 : basePort;
  }

  function devStatusPayload(cb) {
    var port = devServer ? devServer.port : null;
    var running = !!(devServer && tm.has(devServer.terminalId));
    if (!running) devServer = null;
    gitw.probePort(port, function (live) {
      cb({
        type: "workspace_dev_status",
        running: running,
        portLive: live,
        port: port,
        terminalId: devServer ? devServer.terminalId : null,
        script: devServer ? devServer.script : null,
      });
    });
  }

  function broadcastDevStatus() {
    devStatusPayload(function (p) { send(p); });
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
    var branch = gitw.getBranch(cwd);
    var env = gitw.ghEnvFor(cwd);
    var refs = gatherRefs(session, repo);

    var dev = null;
    var det = gitw.detectDev(cwd);
    if (det) {
      var port = desiredPort(det.basePort);
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
        worktree: worktreeMeta
          ? { isWorktree: true, parentSlug: worktreeMeta.parentSlug, branch: worktreeMeta.branch, accessible: worktreeMeta.accessible }
          : { isWorktree: false },
        board: res[0],
        pr: res[1],
        items: res[2].filter(Boolean),
        truncatedItems: 0,
        sessionMedia: collectSessionMedia(session),
        dev: dev,
      };
      // Fold in live dev-server status.
      devStatusPayload(function (st) {
        if (state.dev) {
          state.dev.status = st.running ? (st.portLive ? "running" : "starting") : "stopped";
          state.dev.running = st.running;
          state.dev.portLive = st.portLive;
          if (st.running && st.port) { state.dev.port = st.port; state.dev.localUrl = "http://localhost:" + st.port; }
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

    if (msg.type === "workspace_dev_start") {
      if (!canUseTerminal(ws)) {
        sendTo(ws, { type: "workspace_dev_status", running: false, error: "Terminal access is not permitted" });
        return true;
      }
      if (devServer && tm.has(devServer.terminalId)) { broadcastDevStatus(); return true; }
      var det = gitw.detectDev(cwd);
      if (!det) {
        sendTo(ws, { type: "workspace_dev_status", running: false, error: "No dev script found in package.json" });
        return true;
      }
      var port = desiredPort(det.basePort);
      var command = (port ? "PORT=" + port + " " : "") + det.command;
      var t = tm.create(msg.cols || 120, msg.rows || 30, getOsUserInfoForWs(ws), ws, {
        kind: "dev-server",
        title: "dev:" + (port || det.script),
        initialInput: command + "\n",
        onExit: function () { devServer = null; broadcastDevStatus(); },
      });
      if (!t) {
        sendTo(ws, { type: "workspace_dev_status", running: false, error: "Cannot spawn dev server (node-pty unavailable or terminal limit reached)" });
        return true;
      }
      devServer = { terminalId: t.id, port: port, script: det.script, command: command, startedAt: now() };
      send({ type: "term_list", terminals: tm.list() });
      broadcastDevStatus();
      return true;
    }

    if (msg.type === "workspace_dev_stop") {
      if (devServer) {
        tm.close(devServer.terminalId);
        devServer = null;
        send({ type: "term_list", terminals: tm.list() });
      }
      broadcastDevStatus();
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
