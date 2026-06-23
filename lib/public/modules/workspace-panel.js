// Session Context ("Workspace") panel — client side.
//
// A slide-in side panel (same pattern as the Terminal / File Viewer panels)
// that surfaces, for the active session: linked GitHub issues/PRs with their
// media, the project board + PR + preview links, the worktree/branch, all
// session-attached screenshots, and a Start/Stop dev-server control.
//
// State/deps follow CLIENT_MODULE_DEPS.md: store.js + ws-ref.js + direct
// imports, no _ctx bag.

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { escapeHtml, showToast } from './utils.js';
import { showMediaModal } from './app-misc.js';
import { refreshIcons } from './icons.js';
import { addPendingImageFromUrl } from './input.js';
import { closeTerminal } from './terminal.js';
import { closeFileViewer } from './filebrowser.js';
import { closeSidebar } from './sidebar.js';
import { getCachedSessions } from './sidebar-sessions.js';

var isOpen = false;
var subscribed = false;
var devPollTimer = null;          // periodic dev-server status poll (panel open)
var DEV_POLL_MS = 5000;

// Per-session cache. The transcript can only grow, so we load a session's
// context once and reuse it on every revisit (no "Loading" flicker, no
// refetch). We re-fetch only when the session has moved forward — when its
// lastActivity advances or a turn completes while the panel is open.
var stateBySession = {};   // sessionId -> { state, activity }
var requestedFor = null;   // sessionId of the in-flight workspace_get

function panelEl() { return document.getElementById("workspace-panel"); }
function bodyEl() { return document.getElementById("workspace-body"); }

function curSession() { return store.get('activeSessionId'); }

function activityOf(id) {
  if (id == null) return 0;
  var list = getCachedSessions() || [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(id)) return list[i].lastActivity || 0;
  }
  return 0;
}

function sendWs(obj) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Fire a workspace_get for the active session. Never shows "Loading" itself —
// the caller decides whether to show a placeholder first.
function requestState() {
  if (!store.get('connected')) return;
  requestedFor = curSession();
  sendWs({ type: "workspace_get", sessionId: requestedFor });
}

// Poll the dev-server status while the panel is open. This is a lightweight
// message (just a port probe server-side) so the panel notices servers that
// were started or stopped outside Clay, instead of showing a stale status.
function pollDevStatus() {
  if (!isOpen || !store.get('connected')) return;
  sendWs({ type: "workspace_dev_status_get", sessionId: curSession() });
}

function startDevPoll() {
  if (devPollTimer) return;
  devPollTimer = setInterval(pollDevStatus, DEV_POLL_MS);
}

function stopDevPoll() {
  if (!devPollTimer) return;
  clearInterval(devPollTimer);
  devPollTimer = null;
}

// Render the active session: cached content instantly, fetching only when we
// have no cache or the session advanced. `force` always refetches (Refresh).
function showForActive(force) {
  var id = curSession();
  var cached = stateBySession[id];
  if (cached) {
    render(cached.state);
    if (force || activityOf(id) > cached.activity) requestState();
  } else {
    renderLoading();
    requestState();
  }
}

export function initWorkspacePanel() {
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.addEventListener("click", toggleWorkspacePanel);

  var closeBtn = document.getElementById("workspace-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeWorkspacePanel);

  var refreshBtn = document.getElementById("workspace-refresh-btn");
  if (refreshBtn) refreshBtn.addEventListener("click", function () { showForActive(true); });

  if (!subscribed) {
    subscribed = true;
    store.subscribe(function (state, prev) {
      if (!isOpen) return;
      // Switched sessions: show that session's cache (fetch once if unseen).
      if (state.activeSessionId !== prev.activeSessionId) { showForActive(false); return; }
      // A turn just completed in this session: chat moved forward, so pull the
      // delta (new issue refs / media). Silent — keep current content shown.
      if (prev.processing && !state.processing) requestState();
    });
  }
}

export function toggleWorkspacePanel() {
  if (isOpen) closeWorkspacePanel();
  else openWorkspacePanel();
}

export function openWorkspacePanel() {
  var el = panelEl();
  if (!el) return;
  // Mutually exclusive with the other right-hand panels.
  closeFileViewer();
  closeTerminal();
  el.classList.remove("hidden");
  isOpen = true;
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.classList.add("active");
  if (window.innerWidth <= 768) closeSidebar();
  showForActive(false);
  startDevPoll();
  refreshIcons();
}

export function closeWorkspacePanel() {
  var el = panelEl();
  if (!el) return;
  el.classList.remove("panel-fullscreen");
  el.classList.add("hidden");
  isOpen = false;
  stopDevPoll();
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.classList.remove("active");
}

// --- Message handlers (routed from app-messages.js) ---------------------

export function handleWorkspaceState(msg) {
  var id = (msg.sessionId != null) ? msg.sessionId : requestedFor;
  if (msg.error) {
    if (isOpen && String(id) === String(curSession())) renderError(msg.error);
    return;
  }
  stateBySession[id] = { state: msg, activity: activityOf(id) };
  if (isOpen && String(id) === String(curSession())) render(msg);
}

export function handleWorkspaceDevStatus(msg) {
  // The dev server is per-project; reflect it in the active session's cache.
  var id = curSession();
  var cached = stateBySession[id];
  if (cached && cached.state && cached.state.dev) {
    var dev = cached.state.dev;
    dev.running = msg.running;
    dev.portLive = msg.portLive;
    dev.external = msg.external;
    dev.status = msg.status || (msg.running ? (msg.portLive ? "running" : "starting") : "stopped");
    if (msg.branch !== undefined) dev.branch = msg.branch;
    if (msg.port) { dev.port = msg.port; dev.localUrl = "http://localhost:" + msg.port; }
    dev.terminalId = msg.terminalId;
  }
  if (isOpen) {
    // Update only the dev section so we don't disturb the rest of the panel
    // (e.g. the "Add issue" input). Fall back to a full/dev-only render if the
    // section isn't on the page yet.
    if (cached && cached.state) {
      if (!updateDevSection(cached.state)) render(cached.state);
    } else {
      renderDevOnly(msg);
    }
  }
}

// --- Rendering ----------------------------------------------------------

function renderLoading() {
  var b = bodyEl();
  if (b) b.innerHTML = '<div class="ws-empty">Loading session context…</div>';
}

function renderError(text) {
  var b = bodyEl();
  if (b) b.innerHTML = '<div class="ws-empty ws-error">' + escapeHtml(text) + '</div>';
}

function renderDevOnly(msg) {
  var b = bodyEl();
  if (!b) return;
  var status = msg.status || (msg.running ? "running" : "stopped");
  var dev = (status === "stopped")
    ? null
    : { status: status, port: msg.port, external: msg.external, localUrl: msg.port ? "http://localhost:" + msg.port : null };
  b.innerHTML = devSectionHtml({ dev: dev });
  wireDevButton(b);
  refreshIcons();
}

function stateChip(state) {
  if (!state) return "";
  var cls = "ws-chip ws-state-" + escapeHtml(state.toLowerCase());
  return '<span class="' + cls + '">' + escapeHtml(state) + '</span>';
}

function mediaThumbsHtml(media) {
  if (!media || !media.length) return "";
  var html = '<div class="ws-media-grid">';
  for (var i = 0; i < media.length; i++) {
    var m = media[i];
    var url = escapeHtml(m.url);
    if (m.type === "image") {
      html += '<a class="ws-thumb" href="' + url + '" target="_blank" rel="noopener" title="' + url + '"><img src="' + url + '" loading="lazy" alt=""></a>';
    } else if (m.type === "video") {
      html += '<a class="ws-thumb ws-thumb-video" href="' + url + '" target="_blank" rel="noopener" title="' + url + '"><i data-lucide="play-circle"></i></a>';
    } else {
      html += '<a class="ws-thumb ws-thumb-link" href="' + url + '" target="_blank" rel="noopener" title="' + url + '"><i data-lucide="paperclip"></i></a>';
    }
  }
  html += '</div>';
  return html;
}

// Session screenshots: same thumbnail, plus Copy and "Add to chat" actions.
function sessionMediaHtml(media) {
  if (!media || !media.length) return "";
  var html = '<div class="ws-media-grid">';
  for (var i = 0; i < media.length; i++) {
    var url = escapeHtml(media[i].url);
    html += '<div class="ws-shot">' +
      '<a class="ws-thumb" href="' + url + '" target="_blank" rel="noopener" title="Open in new tab"><img src="' + url + '" loading="lazy" alt=""></a>' +
      '<div class="ws-shot-actions">' +
        '<button class="ws-shot-btn" data-copy="' + url + '" title="Copy image"><i data-lucide="copy"></i></button>' +
        '<button class="ws-shot-btn" data-add="' + url + '" title="Add to chat message"><i data-lucide="message-square-plus"></i></button>' +
      '</div>' +
    '</div>';
  }
  html += '</div>';
  return html;
}

// Copy an image URL to the clipboard as PNG (the only format browsers accept
// for image clipboard writes), converting via canvas when needed.
function copyImageToClipboard(url) {
  if (!navigator.clipboard || !window.ClipboardItem) { showToast("Clipboard not supported in this browser", "error"); return; }
  fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
    .then(function (blob) { return blob.type === "image/png" ? blob : blobToPng(blob); })
    .then(function (png) { return navigator.clipboard.write([new window.ClipboardItem({ "image/png": png })]); })
    .then(function () { showToast("Screenshot copied", "success"); })
    .catch(function (e) { showToast("Copy failed: " + (e && e.message || e), "error"); });
}

function blobToPng(blob) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var u = URL.createObjectURL(blob);
    img.onload = function () {
      var c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(u);
      c.toBlob(function (b) { b ? resolve(b) : reject(new Error("encode failed")); }, "image/png");
    };
    img.onerror = function () { URL.revokeObjectURL(u); reject(new Error("image load failed")); };
    img.src = u;
  });
}

function linkBtn(href, icon, label) {
  return '<a class="ws-linkbtn" href="' + escapeHtml(href) + '" target="_blank" rel="noopener"><i data-lucide="' + icon + '"></i>' + escapeHtml(label) + '</a>';
}

function itemCardHtml(item) {
  var labels = "";
  if (item.labels && item.labels.length) {
    labels = '<div class="ws-labels">';
    for (var i = 0; i < item.labels.length; i++) labels += '<span class="ws-label">' + escapeHtml(item.labels[i]) + '</span>';
    labels += '</div>';
  }
  var pinIcon = item.pinned ? "pin-off" : "pin";
  var pinTitle = item.pinned ? "Unpin" : "Pin to session";
  var typeIcon = item.type === "pr" ? "git-pull-request" : "circle-dot";
  var numLabel = (item.type === "pr" ? "PR #" : "#") + item.number;
  var titleText = item.title ? (numLabel + " · " + item.title) : numLabel;
  var linkRow = item.previewUrl ? '<div class="ws-linkrow">' + linkBtn(item.previewUrl, "external-link", "Preview") + '</div>' : "";
  return '' +
    '<div class="ws-item">' +
      '<div class="ws-item-head">' +
        '<a class="ws-item-title" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener" title="' + escapeHtml(titleText) + '"><i data-lucide="' + typeIcon + '"></i>' + escapeHtml(titleText) + '</a>' +
        stateChip(item.state) +
        '<button class="ws-pin-btn" data-pin="' + escapeHtml(item.slug || "") + '#' + item.number + '" data-pinned="' + (item.pinned ? "1" : "0") + '" title="' + pinTitle + '"><i data-lucide="' + pinIcon + '"></i></button>' +
      '</div>' +
      labels +
      linkRow +
      mediaThumbsHtml(item.media) +
    '</div>';
}

function devSectionHtml(state) {
  var dev = state.dev;
  if (!dev) {
    return '<div class="ws-section" id="ws-dev-section"><div class="ws-section-title">Local environment</div>' +
      '<div class="ws-empty-sm">No dev script detected in package.json.</div></div>';
  }
  var status = dev.status || "stopped";
  var external = status === "external";
  var isUp = status === "running" || status === "external";
  var dotCls = isUp ? "ws-dot-on" : status === "starting" ? "ws-dot-warn" : "ws-dot-off";
  var statusLabel = external ? "running (external)" : status;
  // We can only start/stop a server Clay owns. If one was started outside Clay,
  // surface a note instead of a Stop button (we have no terminal to close).
  var control;
  if (external) {
    // We can't stop a process Clay didn't start, but the port may be held by a
    // different project or a stale app. "Re-run here" reclaims the port and
    // starts this project's dev server in its place.
    control = '<button class="ws-devbtn ws-dev-restart" data-dev="restart"><i data-lucide="refresh-cw"></i>Re-run here</button>' +
      '<div class="ws-empty-sm">Started outside Clay — possibly a different project on port ' + escapeHtml(String(dev.port || "")) + '. Re-run here stops it and starts this project\'s dev server.</div>';
  } else {
    var btnLabel = (status === "stopped") ? "Start dev server" : "Stop dev server";
    var btnAction = (status === "stopped") ? "start" : "stop";
    var btnIcon = (status === "stopped") ? "play" : "square";
    control = '<button class="ws-devbtn ws-dev-' + btnAction + '" data-dev="' + btnAction + '"><i data-lucide="' + btnIcon + '"></i>' + btnLabel + '</button>';
  }
  var localLink = dev.localUrl && isUp
    ? '<a class="ws-linkbtn" href="' + escapeHtml(dev.localUrl) + '" target="_blank" rel="noopener"><i data-lucide="external-link"></i>' + escapeHtml(dev.localUrl) + '</a>'
    : '<span class="ws-muted">' + escapeHtml(dev.localUrl || "") + '</span>';
  // When the env is bound to the session's worktree, show which branch it serves.
  var branchRow = dev.branch
    ? '<div class="ws-kv"><span class="ws-k">Branch</span><span class="ws-v"><code>' + escapeHtml(dev.branch) + '</code> <span class="ws-chip ws-chip-wt">worktree</span></span></div>'
    : '';
  return '' +
    '<div class="ws-section" id="ws-dev-section">' +
      '<div class="ws-section-title">Local environment</div>' +
      '<div class="ws-kv"><span class="ws-k">Script</span><span class="ws-v"><code>' + escapeHtml(dev.command || dev.script || "") + '</code></span></div>' +
      branchRow +
      '<div class="ws-kv"><span class="ws-k">Port</span><span class="ws-v">' + escapeHtml(String(dev.port || "—")) + '</span></div>' +
      '<div class="ws-kv"><span class="ws-k">Status</span><span class="ws-v"><span class="ws-dot ' + dotCls + '"></span>' + escapeHtml(statusLabel) + '</span></div>' +
      '<div class="ws-linkrow">' + localLink + '</div>' +
      control +
    '</div>';
}

// Wire the start/stop button inside a dev-section container.
function wireDevButton(scope) {
  var devBtn = scope.querySelector(".ws-devbtn");
  if (devBtn) devBtn.addEventListener("click", function () {
    var action = this.getAttribute("data-dev");
    var type = action === "start" ? "workspace_dev_start"
      : action === "restart" ? "workspace_dev_restart"
      : "workspace_dev_stop";
    sendWs({ type: type });
    this.disabled = true;
  });
}

// Replace just the dev section in place (used by the poll/status updates) so we
// don't blow away the rest of the panel — notably the "Add issue" input the
// user may be typing into.
function updateDevSection(state) {
  var b = bodyEl();
  if (!b) return false;
  var cur = b.querySelector("#ws-dev-section");
  if (!cur) return false;
  var tmp = document.createElement("div");
  tmp.innerHTML = devSectionHtml(state);
  var next = tmp.firstChild;
  cur.parentNode.replaceChild(next, cur);
  wireDevButton(next);
  refreshIcons();
  return true;
}

function render(state) {
  var b = bodyEl();
  if (!b) return;
  var html = "";

  // Workspace / repo section
  html += '<div class="ws-section">';
  html += '<div class="ws-section-title">Workspace</div>';
  if (state.repo) {
    html += '<div class="ws-kv"><span class="ws-k">Repo</span><span class="ws-v"><a href="' + escapeHtml(state.repo.url) + '" target="_blank" rel="noopener">' + escapeHtml(state.repo.slug) + '</a></span></div>';
  }
  if (state.branch) {
    var wtBadge = state.worktree && state.worktree.isWorktree ? ' <span class="ws-chip ws-chip-wt">worktree</span>' : '';
    html += '<div class="ws-kv"><span class="ws-k">Branch</span><span class="ws-v"><code>' + escapeHtml(state.branch) + '</code>' + wtBadge + '</span></div>';
    // Active worktree: the session is editing here, not in the project's main
    // checkout — make that explicit so the branch label isn't mistaken for the
    // main branch.
    if (state.worktree && state.worktree.active) {
      html += '<div class="ws-note"><i data-lucide="git-branch"></i><span>Bound to this session’s worktree' +
        (state.worktree.mainBranch ? ' (main checkout is on <code>' + escapeHtml(state.worktree.mainBranch) + '</code>)' : '') +
        '.</span></div>';
    }
  }
  var wsLinks = "";
  if (state.board) wsLinks += linkBtn(state.board, "kanban", "Board");
  if (state.pr) {
    wsLinks += linkBtn(state.pr.url, "git-pull-request", "PR #" + state.pr.number);
    if (state.pr.previewUrl) wsLinks += linkBtn(state.pr.previewUrl, "external-link", "Preview");
  }
  if (wsLinks) html += '<div class="ws-linkrow">' + wsLinks + '</div>';
  html += '</div>';

  // Dev / local environment
  html += devSectionHtml(state);

  // Linked items
  html += '<div class="ws-section">';
  html += '<div class="ws-section-title">Linked issues &amp; PRs</div>';
  if (state.items && state.items.length) {
    for (var i = 0; i < state.items.length; i++) html += itemCardHtml(state.items[i]);
    if (state.truncatedItems) html += '<div class="ws-empty-sm">+' + state.truncatedItems + ' more not expanded</div>';
  } else {
    html += '<div class="ws-empty-sm">No issues detected yet. Mention an issue number in chat, or add one below.</div>';
  }
  html += '<div class="ws-add"><input type="text" id="ws-add-input" placeholder="Add issue # or URL" spellcheck="false"><button class="ws-addbtn" id="ws-add-btn"><i data-lucide="plus"></i></button></div>';
  html += '</div>';

  // Session media
  if (state.sessionMedia && state.sessionMedia.length) {
    html += '<div class="ws-section"><div class="ws-section-title">Session screenshots</div>' + sessionMediaHtml(state.sessionMedia) + '</div>';
  }

  b.innerHTML = html;
  wireBody(b);
  refreshIcons();
}

function wireBody(b) {
  // Media tiles are plain target="_blank" links — clicking opens the image/
  // video in a new tab (top-level navigation, so GitHub auth + inline display
  // work) instead of downloading. Gracefully fall back broken thumbnails
  // (e.g. private images we can't load in-app) to a generic icon.
  var imgs = b.querySelectorAll(".ws-thumb img");
  for (var i = 0; i < imgs.length; i++) {
    imgs[i].addEventListener("error", function () {
      var a = this.parentNode;
      if (a) { a.classList.add("ws-thumb-link"); a.innerHTML = '<i data-lucide="image"></i>'; refreshIcons(); }
    });
  }
  // Open images/videos in the in-app lightbox instead of a new tab. Assets that
  // can't render in-app (private GitHub images whose thumbnail failed to load,
  // or non-media files) keep the anchor's native target=_blank — top-level
  // navigation is the only way those carry GitHub auth. Videos try the popup
  // and fall back to "Open in new tab" inside the modal if they can't play.
  var thumbs = b.querySelectorAll("a.ws-thumb");
  for (var t = 0; t < thumbs.length; t++) {
    thumbs[t].addEventListener("click", function (e) {
      var isVideo = this.classList.contains("ws-thumb-video");
      // ws-thumb-link = a non-image file, or an image whose preview failed.
      if (!isVideo && this.classList.contains("ws-thumb-link")) return;
      var url = this.getAttribute("href");
      if (!url) return;
      e.preventDefault();
      showMediaModal(url, isVideo ? "video" : "image");
    });
  }
  // Session screenshot actions: copy to clipboard / re-add to the composer.
  var copyBtns = b.querySelectorAll(".ws-shot-btn[data-copy]");
  for (var c = 0; c < copyBtns.length; c++) {
    copyBtns[c].addEventListener("click", function () { copyImageToClipboard(this.getAttribute("data-copy")); });
  }
  var addBtns = b.querySelectorAll(".ws-shot-btn[data-add]");
  for (var ad = 0; ad < addBtns.length; ad++) {
    addBtns[ad].addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      addPendingImageFromUrl(btn.getAttribute("data-add"))
        .then(function () { showToast("Added to chat message", "success"); })
        .catch(function (e) { showToast("Couldn't add image: " + (e && e.message || e), "error"); })
        .then(function () { btn.disabled = false; });
    });
  }
  // Dev start/stop.
  wireDevButton(b);
  // Pin / unpin.
  var pinBtns = b.querySelectorAll(".ws-pin-btn");
  for (var p = 0; p < pinBtns.length; p++) {
    pinBtns[p].addEventListener("click", function () {
      var ref = (this.getAttribute("data-pin") || "").split("#");
      var pinned = this.getAttribute("data-pinned") === "1";
      if (ref.length !== 2) return;
      sendWs({ type: pinned ? "workspace_unpin_item" : "workspace_pin_item", slug: ref[0] || null, number: parseInt(ref[1], 10) });
    });
  }
  // Add issue.
  var addBtn = b.querySelector("#ws-add-btn");
  var addInput = b.querySelector("#ws-add-input");
  function submitAdd() {
    if (!addInput) return;
    var raw = addInput.value.trim();
    if (!raw) return;
    var slug = null;
    var number = null;
    var m = raw.match(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/);
    if (m) { slug = m[1]; number = parseInt(m[2], 10); }
    else { var n = raw.match(/(\d+)/); if (n) number = parseInt(n[1], 10); }
    if (!number) return;
    sendWs({ type: "workspace_pin_item", slug: slug, number: number });
    addInput.value = "";
  }
  if (addBtn) addBtn.addEventListener("click", submitAdd);
  if (addInput) addInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submitAdd(); });
}
