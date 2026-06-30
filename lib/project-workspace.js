// Session Context ("Workspace") panel — server side.
//
// Assembles, for the session a client is viewing: the repo + branch, worktree
// status, linked GitHub issues/PRs (auto-detected from the transcript + task
// launcher + manual pins) with their media, the project board URL, the PR for
// the branch (+ preview deploy URL), session-attached images, and the dev
// script + computed port. Also starts/stops dev servers (PTYs spawned through
// the shared terminal manager): the main checkout and every git worktree get
// their own server on the first free port at/above the project's base port, so
// any number of sessions/worktrees can run concurrently without colliding. The
// panel always reports the port a server actually bound to.
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
  var STAGING_TTL = 30 * 1000;  // re-poll deploy state at most this often per commit

  // Dev servers keyed by resolved working directory, so the main checkout and
  // each git worktree can run concurrently on their own ports:
  //   resolvedCwd -> { terminalId, port, script, command, branch, startedAt }
  var devServers = {};
  var boardCache = { url: null, at: 0 };
  var itemCache = {}; // "slug#n" -> { data, at }
  var stagingCache = {}; // headSha -> { url, at }

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

  // Entry types whose text is tool or system output rather than human/assistant
  // prose: file contents, command output, diffs, logs, the agent's private
  // thinking, and status lines. These routinely contain incidental issue/PR
  // URLs the session is NOT about (e.g. an example URL hardcoded in a source
  // file the agent happened to read), so they are excluded from URL-reference
  // harvesting — otherwise a single `gh`/file read pollutes the panel with
  // unrelated links.
  var NONPROSE_ENTRY = {
    tool_result: 1, tool_start: 1, tool_executing: 1, subagent_tool: 1,
    thinking_start: 1, thinking_delta: 1, thinking_stop: 1,
    task_started: 1, task_progress: 1,
    info: 1, scheduled_message_queued: 1, prompt_suggestion: 1, system: 1,
  };

  // Two text scopes. `prose` is human + assistant narrative (used for
  // unambiguous github URLs), excluding tool/system output. `user` is
  // user-authored messages only (used for bare #N — assistant/tool text is full
  // of stray numbers that resolve to unrelated issues on large repos).
  function scanText(session) {
    var prose = [];
    var userOnly = [];
    if (session && Array.isArray(session.history)) {
      for (var i = 0; i < session.history.length; i++) {
        var e = session.history[i];
        if (!e) continue;
        var t = (typeof e.text === "string") ? e.text : (typeof e.content === "string") ? e.content : "";
        if (!t) continue;
        if (!NONPROSE_ENTRY[e.type]) prose.push(t);
        if (USER_ENTRY[e.type]) userOnly.push(t);
      }
    }
    if (session && session.taskLauncher && session.taskLauncher.itemUrl) prose.push(session.taskLauncher.itemUrl);
    return { prose: prose.join("\n"), user: userOnly.join("\n") };
  }

  function gatherRefs(session, repo) {
    var defaultSlug = repo ? repo.slug : null;
    var refs = [];
    // The issue/PR this session was launched for is essential: it's the reason
    // the session exists, so it must always appear in the panel — with a
    // fallback link when gh enrichment fails (offline, rate-limited, timed out)
    // instead of silently vanishing the way ordinary auto-detected refs do.
    if (session && session.taskLauncher && session.taskLauncher.itemNumber && defaultSlug) {
      refs.push({
        slug: defaultSlug,
        number: session.taskLauncher.itemNumber,
        essential: true,
        type: session.taskLauncher.autoKind === "pr-review" ? "pr" : "issue",
        url: session.taskLauncher.itemUrl || null,
      });
    }
    var text = scanText(session);
    var scanned = gitw.parseUrlRefs(text.prose).concat(gitw.parseHashRefs(text.user, defaultSlug));
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
      if (seen[key]) {
        if (ref.pinned) seen[key].pinned = true;
        if (ref.essential) {
          seen[key].essential = true;
          if (ref.type) seen[key].type = ref.type;
          if (ref.url) seen[key].url = ref.url;
        }
        continue;
      }
      seen[key] = { slug: ref.slug, number: ref.number, pinned: !!ref.pinned, essential: !!ref.essential, type: ref.type || null, url: ref.url || null };
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

  // A minimal item for a ref that failed enrichment (e.g. a transient gh error)
  // but must stay visible: a manually-pinned ref (the user added it by hand) or
  // the essential task-launcher issue (the session exists for it). It keeps a
  // working GitHub link rather than silently vanishing — unlike ordinary
  // auto-detected refs, which are dropped when they don't resolve so the panel
  // never shows a speculative dead link.
  function fallbackItem(ref) {
    var type = ref.type === "pr" ? "pr" : "issue";
    var url = ref.url || ("https://github.com/" + ref.slug + "/" + (type === "pr" ? "pull" : "issues") + "/" + ref.number);
    return {
      number: ref.number,
      slug: ref.slug,
      type: type,
      title: "",
      state: "",
      url: url,
      labels: [],
      media: [],
      previewUrl: null,
      pinned: !!ref.pinned,
      unresolved: true,
    };
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

  // The branch a session is actually on. session.activeWorktree.branch records
  // the branch at worktree-creation time, but the agent may switch branches
  // inside the worktree afterwards — leaving that value stale. Read the live
  // HEAD of the worktree dir so PR/preview lookup targets the real branch.
  function liveBranchFor(aw, mainBranch) {
    if (!aw) return mainBranch;
    return gitw.getBranch(aw.devCwd || aw.root) || aw.branch || mainBranch;
  }

  // The live dev server we started for a directory, if still running. Reaps the
  // map entry when its terminal is gone.
  function liveServerFor(dirAbs) {
    var s = devServers[dirAbs];
    if (s && tm.has(s.terminalId)) return s;
    if (s) delete devServers[dirAbs];
    return null;
  }

  // The directory whose dev server THIS session controls. Once a session starts
  // a dev server, it stays bound to that directory for as long as the server is
  // alive — so Stop/Restart keep targeting the worktree the user launched, and
  // the panel keeps reporting it, even if the session's active-worktree
  // association later drifts (e.g. the agent edits elsewhere). When there is no
  // live server, bind to the worktree the session is currently editing in (or
  // the project's main checkout).
  function boundDirFor(session) {
    if (session && session.devCwdAbs && liveServerFor(session.devCwdAbs)) return session.devCwdAbs;
    var aw = activeWtFor(session);
    return path.resolve(aw ? aw.devCwd : cwd);
  }

  // Ports our own live dev servers currently hold, excluding the directory
  // `exceptAbs` (the one we're about to (re)start). Used to keep port selection
  // from handing the same port to two concurrent servers.
  function ownLivePorts(exceptAbs) {
    var ports = [];
    Object.keys(devServers).forEach(function (k) {
      var s = devServers[k];
      if (s && k !== exceptAbs && s.port && tm.has(s.terminalId)) ports.push(s.port);
    });
    return ports;
  }

  // Poll until a port is free (after killing the previous worktree server) so
  // the replacement binds the same port instead of falling back to the next one.
  function waitPortFree(port, tries, cb) {
    if (!port || tries <= 0) return cb();
    gitw.probePort(port, function (live) {
      if (!live) return cb();
      setTimeout(function () { waitPortFree(port, tries - 1, cb); }, 250);
    });
  }

  // Dev-server status for the directory THIS session is bound to (its worktree,
  // or the main checkout). Each directory has its own independent server on its
  // own port — there is no shared slot, so sessions never fight over a port.
  function devStatusPayload(session, cb) {
    var boundAbs = boundDirFor(session);
    var mainAbs = path.resolve(cwd);
    var isWorktree = boundAbs !== mainAbs;
    var det = gitw.detectDev(boundAbs);
    var server = liveServerFor(boundAbs);
    // Branch label is only meaningful for a worktree (the main checkout's branch
    // isn't shown as a "worktree" chip). A running server remembers the branch
    // it was launched for; otherwise read it straight from the bound directory.
    var branch = !isWorktree ? null : (server ? server.branch : gitw.getBranch(boundAbs));

    function payload(over) {
      return Object.assign({
        type: "workspace_dev_status",
        running: false,
        portLive: false,
        external: false,
        status: "stopped",
        port: null,
        branch: branch,
        isWorktree: isWorktree,
        terminalId: null,
        script: det ? det.script : null,
        command: det ? det.command : null,
      }, over);
    }

    if (server) {
      // Running server: report the port it actually bound to, so the panel
      // always points at where this worktree is being served.
      gitw.probePort(server.port, function (live) {
        cb(payload({
          running: true,
          portLive: live,
          status: live ? "running" : "starting",
          port: server.port,
          terminalId: server.terminalId,
        }));
      });
      return;
    }

    // Stopped: preview the port a fresh start would bind — the first free port
    // at/above basePort, skipping ports our other live servers already hold.
    if (!det || !det.basePort) return cb(payload({ port: det ? det.basePort : null }));
    gitw.findFreePort(det.basePort, ownLivePorts(boundAbs), function (port) {
      cb(payload({ port: port }));
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

  // --- shared skeleton builders -------------------------------------------

  // The dev panel object derived from a dev-status payload (or null when the
  // project has no dev script). Shared by buildState and the context push so
  // they always describe the dev server identically.
  function devFromStatus(st) {
    if (!st || !st.script) return null;
    return {
      script: st.script, command: st.command,
      port: st.port, localUrl: st.port ? "http://localhost:" + st.port : null,
      status: st.status, running: st.running, portLive: st.portLive,
      external: st.external, branch: st.branch, terminalId: st.terminalId,
    };
  }

  // The worktree descriptor the panel renders (branch chip + "bound to worktree"
  // note). `aw` is the session's active worktree (or null for the main checkout).
  function worktreeInfo(aw, mainBranch) {
    if (aw) return { isWorktree: true, active: true, branch: liveBranchFor(aw, mainBranch), root: aw.root, mainBranch: mainBranch };
    if (worktreeMeta) return { isWorktree: true, parentSlug: worktreeMeta.parentSlug, branch: worktreeMeta.branch, accessible: worktreeMeta.accessible };
    return { isWorktree: false };
  }

  // Push a lightweight context update (branch, worktree, dev status) for one
  // session to all clients, so an open panel tracks the worktree the agent is
  // editing in live — mid-turn, without a full GitHub refetch. The client merges
  // it into the matching session's cached state (see handleWorkspaceContext).
  function notifyContextChanged(session) {
    if (!session) return;
    var aw = activeWtFor(session);
    var mainBranch = gitw.getBranch(cwd);
    devStatusPayload(session, function (st) {
      send({
        type: "workspace_context",
        sessionId: session.localId != null ? session.localId : null,
        branch: liveBranchFor(aw, mainBranch),
        worktree: worktreeInfo(aw, mainBranch),
        dev: devFromStatus(st),
      });
    });
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

  // Resolve the staging/preview URL for the PR's head commit, gated on deploy
  // state (only returns a URL once CI has deployed). Cached per commit SHA with
  // a short TTL so the panel re-polls while CI runs without hammering the API.
  function resolveStagingUrl(repo, sha, env) {
    if (!repo || !sha) return Promise.resolve(null);
    var cached = stagingCache[sha];
    if (cached && (now() - cached.at) < STAGING_TTL) return Promise.resolve(cached.url);
    return gitw.fetchStagingUrl(cwd, repo, sha, env).then(function (url) {
      stagingCache[sha] = { url: url || null, at: now() };
      return url || null;
    });
  }

  // Resolve the PR for the branch (+ its media and a state-gated staging URL).
  function resolvePr(repo, branch, env) {
    if (!repo || !branch) return Promise.resolve(null);
    return gitw.findPrForBranch(cwd, repo, branch, env).then(function (prRaw) {
      if (!prRaw) return null;
      return Promise.all([
        enrichItem({ slug: repo.slug, number: prRaw.number }, env),
        resolveStagingUrl(repo, prRaw.headRefOid, env),
      ]).then(function (r) {
        var prItem = r[0];
        var deployUrl = r[1];
        return {
          number: prRaw.number,
          url: prRaw.url,
          title: prRaw.title,
          state: prRaw.state,
          // Prefer the state-gated deploy URL; fall back to a URL scraped from
          // the PR body/comments only when no deployment/status URL is ready.
          previewUrl: deployUrl || (prItem ? prItem.previewUrl : null),
          media: prItem ? prItem.media : [],
        };
      });
    });
  }

  // Two-phase load. GitHub round-trips (board, PR, and each linked issue/PR via
  // the gh CLI) are the slow part, so we send a cheap, fully-local "skeleton"
  // first — repo, branch, worktree, dev script + live status, session
  // screenshots — and the client renders it instantly. The enriched state with
  // GitHub data follows as a second message that patches in the issues/PRs.
  // `cb` is therefore called up to twice: once with `partial:true`, then once
  // with the complete state (`partial:false`).
  function buildState(session, cb) {
    var repo = gitw.getRepo(cwd);
    var env = gitw.ghEnvFor(cwd);
    var refs = gatherRefs(session, repo);

    // Bind the panel to the worktree this session is actually editing in, if
    // any — otherwise the project's main checkout.
    var aw = activeWtFor(session);
    var mainBranch = gitw.getBranch(cwd);
    var branch = liveBranchFor(aw, mainBranch);
    var worktree = worktreeInfo(aw, mainBranch);
    var sessionMedia = collectSessionMedia(session);

    // --- Phase 1: skeleton (local only) -----------------------------------
    // Resolve live dev status first (a fast local port probe) so the panel
    // shows the right port/state immediately. The dev object is built entirely
    // from the status payload so it stays bound to the server this session
    // controls (see boundDirFor) rather than re-deriving the directory here.
    devStatusPayload(session, function (st) {
      var dev = devFromStatus(st);
      var base = {
        type: "workspace_state",
        sessionId: session ? session.localId : null,
        repo: repo ? { slug: repo.slug, url: repo.url } : null,
        branch: branch,
        worktree: worktree,
        sessionMedia: sessionMedia,
        dev: dev,
      };
      cb(Object.assign({}, base, { partial: true, board: null, pr: null, items: [], truncatedItems: 0 }));

      // --- Phase 2: GitHub enrichment ------------------------------------
      // Validate + enrich every detected reference concurrently. The first
      // MAX_ENRICHED get full metadata + media; the rest get a cheap existence
      // check. Either way, refs that don't resolve to a real issue/PR drop out.
      var itemPromises = refs.map(function (ref, i) {
        var p = i < MAX_ENRICHED ? enrichItem(ref, env) : verifyItem(ref, env);
        // A manually-pinned ref, or the essential issue/PR this session was
        // launched for, must never silently disappear — keep a minimal fallback
        // (a working GitHub link) when enrichment fails or returns nothing.
        // Plain auto-detected refs are still dropped, so the panel shows no dead
        // links.
        return (ref.pinned || ref.essential) ? p.then(function (item) { return item || fallbackItem(ref); }) : p;
      });
      Promise.all([
        resolveBoard(repo, env),
        resolvePr(repo, branch, env),
        Promise.all(itemPromises),
      ]).then(function (res) {
        var state = Object.assign({}, base, {
          partial: false,
          board: res[0],
          pr: res[1],
          items: res[2].filter(Boolean),
          truncatedItems: 0,
        });
        // Route GitHub-hosted media through the in-app proxy so it renders in
        // the panel without a github.com round-trip.
        if (state.pr && state.pr.media) state.pr.media = proxyMediaList(state.pr.media);
        for (var ii = 0; ii < state.items.length; ii++) {
          if (state.items[ii] && state.items[ii].media) state.items[ii].media = proxyMediaList(state.items[ii].media);
        }
        cb(state);
      }).catch(function (e) {
        cb({ type: "workspace_state", error: "Failed to load workspace context: " + (e && e.message || e) });
      });
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

  // Start the dev server for the directory this session is bound to (its
  // worktree, or the main checkout). The port is chosen dynamically: the first
  // free port at/above the project's base port, skipping ports our other live
  // servers already hold — so two sessions/worktrees never collide on a port.
  // opts.takeover (Restart / "Re-run here") first stops the server Clay owns for
  // this directory and frees its port so the restart can reclaim it in place.
  function startDevServer(ws, msg, opts) {
    opts = opts || {};
    if (!canUseTerminal(ws)) {
      sendTo(ws, { type: "workspace_dev_status", running: false, error: "Terminal access is not permitted" });
      return;
    }
    // Bind to the directory this session controls: the server it already
    // launched if one is alive (so Restart targets it), otherwise the worktree
    // it is currently editing in (or the main checkout). Each such directory
    // gets its own independent server.
    var startSession = getSessionForWs(ws);
    var runAbs = boundDirFor(startSession);
    var runCwd = runAbs;
    var mainAbs = path.resolve(cwd);
    // Plain start: if we already serve this exact directory, just report status.
    // Take over: fall through so we replace whatever is currently running.
    if (!opts.takeover && liveServerFor(runAbs)) {
      // Remember the binding so this session keeps controlling this server.
      if (startSession) startSession.devCwdAbs = runAbs;
      sendDevStatusTo(ws);
      return;
    }
    var det = gitw.detectDev(runCwd);
    if (!det) {
      sendTo(ws, { type: "workspace_dev_status", running: false, error: "No dev script found in package.json" });
      return;
    }
    // The branch the server serves — read straight from the bound directory, so
    // it is correct even if the session's active-worktree association drifts.
    var runBranch = runAbs !== mainAbs ? gitw.getBranch(runAbs) : gitw.getBranch(cwd);

    // On take-over, stop the server Clay owns for this directory so it can be
    // replaced and its port reused. Other directories' servers are left alone —
    // they each have their own port.
    var freedPort = null;
    var existing = devServers[runAbs];
    if (opts.takeover && existing) {
      freedPort = existing.port;
      try { tm.close(existing.terminalId); } catch (e) {}
      delete devServers[runAbs];
    }

    function spawnDev(port) {
      var command = (port ? "PORT=" + port + " " : "") + det.command;
      // The dev server may still bind a different port than we requested (a race
      // grabbed it first, or the framework ignores PORT): most dev servers fall
      // back to the next free port and print the URL they actually bound to.
      // Parse that URL from the server's output and reconcile the stored port,
      // otherwise the panel shows a port that sits on "starting" forever because
      // nothing is listening there — instead of the real one.
      var outBuf = "";
      function onDevData(data) {
        var rec = devServers[runAbs];
        if (!rec || rec.portConfirmed) return;
        outBuf += data;
        if (outBuf.length > 8000) outBuf = outBuf.slice(-8000);
        var clean = outBuf.replace(/\x1b\[[0-9;]*m/g, "");
        var m = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i);
        if (!m) return;
        var real = parseInt(m[1], 10);
        if (!real) return;
        rec.portConfirmed = true;
        if (real !== rec.port) {
          rec.port = real;
          send({ type: "term_list", terminals: tm.list() });
        }
        broadcastDevStatus();
        sendDevStatusTo(ws);
      }
      var t = tm.create(msg.cols || 120, msg.rows || 30, getOsUserInfoForWs(ws), ws, {
        kind: "dev-server",
        title: "dev:" + (port || det.script),
        initialInput: command + "\n",
        cwd: runCwd,
        onData: onDevData,
        onExit: function () { delete devServers[runAbs]; broadcastDevStatus(); },
      });
      if (!t) {
        sendTo(ws, { type: "workspace_dev_status", running: false, error: "Cannot spawn dev server (node-pty unavailable or terminal limit reached)" });
        return;
      }
      devServers[runAbs] = {
        terminalId: t.id, port: port, script: det.script, command: command,
        cwd: runCwd, branch: runBranch, startedAt: now(),
      };
      // Bind this session to the server it just launched so Stop/Restart and
      // the panel keep targeting it even if the active worktree later drifts.
      if (startSession) startSession.devCwdAbs = runAbs;
      send({ type: "term_list", terminals: tm.list() });
      sendDevStatusTo(ws);
    }

    // Pick the first free port at/above basePort, skipping ports our other live
    // servers hold, then spawn there.
    function choosePortAndSpawn() {
      gitw.findFreePort(det.basePort, ownLivePorts(runAbs), spawnDev);
    }
    // After freeing our own port (take-over), wait for it to actually close so
    // findFreePort can hand it back instead of stepping to the next one.
    if (freedPort) {
      gitw.killPort(freedPort, function () { waitPortFree(freedPort, 12, choosePortAndSpawn); });
    } else {
      choosePortAndSpawn();
    }
  }

  function handleWorkspaceMessage(ws, msg) {
    if (msg.type === "workspace_get") {
      var session = getSessionForWs(ws);
      buildState(session, function (state) { sendTo(ws, state); });
      return true;
    }

    if (msg.type === "workspace_dev_status_get") {
      // Lightweight poll: just the dev-server status (no GitHub round-trips).
      // Lets the panel notice servers stopped/exited and keeps it bound to the
      // server this session controls (see boundDirFor).
      sendDevStatusTo(ws);
      return true;
    }

    if (msg.type === "workspace_dev_start") {
      startDevServer(ws, msg, { takeover: false });
      return true;
    }

    if (msg.type === "workspace_dev_restart") {
      // Restart: stop the server this session controls and start it again,
      // reclaiming the same port in place.
      startDevServer(ws, msg, { takeover: true });
      return true;
    }

    if (msg.type === "workspace_dev_stop") {
      // Stop the server this session controls (the one it launched, or the
      // worktree it is editing in) — not a re-derived directory, so Stop always
      // hits the running server even if the active worktree has since drifted.
      var stopSession = getSessionForWs(ws);
      var stopAbs = boundDirFor(stopSession);
      var stopServer = liveServerFor(stopAbs);
      if (stopServer) {
        tm.close(stopServer.terminalId);
        delete devServers[stopAbs];
        send({ type: "term_list", terminals: tm.list() });
      }
      if (stopSession && stopSession.devCwdAbs === stopAbs) stopSession.devCwdAbs = null;
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
    notifyContextChanged: notifyContextChanged,
  };
}

module.exports = { attachWorkspace: attachWorkspace };
