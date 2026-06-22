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
import { escapeHtml } from './utils.js';
import { refreshIcons } from './icons.js';
import { showImageModal } from './app-misc.js';
import { closeTerminal } from './terminal.js';
import { closeFileViewer } from './filebrowser.js';
import { closeSidebar } from './sidebar.js';

var isOpen = false;
var lastState = null;
var subscribed = false;

function panelEl() { return document.getElementById("workspace-panel"); }
function bodyEl() { return document.getElementById("workspace-body"); }

function sendWs(obj) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function requestState() {
  if (!store.get('connected')) return;
  sendWs({ type: "workspace_get", sessionId: store.get('activeSessionId') });
}

export function initWorkspacePanel() {
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.addEventListener("click", toggleWorkspacePanel);

  var closeBtn = document.getElementById("workspace-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeWorkspacePanel);

  var refreshBtn = document.getElementById("workspace-refresh-btn");
  if (refreshBtn) refreshBtn.addEventListener("click", function () {
    renderLoading();
    requestState();
  });

  // Re-fetch when the user switches sessions while the panel is open.
  if (!subscribed) {
    subscribed = true;
    store.subscribe(function (state, prev) {
      if (isOpen && state.activeSessionId !== prev.activeSessionId) {
        lastState = null;
        renderLoading();
        requestState();
      }
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
  if (lastState) render(lastState);
  else renderLoading();
  requestState();
  refreshIcons();
}

export function closeWorkspacePanel() {
  var el = panelEl();
  if (!el) return;
  el.classList.remove("panel-fullscreen");
  el.classList.add("hidden");
  isOpen = false;
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.classList.remove("active");
}

// --- Message handlers (routed from app-messages.js) ---------------------

export function handleWorkspaceState(msg) {
  if (msg.error) {
    if (isOpen) renderError(msg.error);
    return;
  }
  lastState = msg;
  if (isOpen) render(msg);
}

export function handleWorkspaceDevStatus(msg) {
  if (lastState && lastState.dev) {
    lastState.dev.running = msg.running;
    lastState.dev.portLive = msg.portLive;
    lastState.dev.status = msg.running ? (msg.portLive ? "running" : "starting") : "stopped";
    if (msg.port) { lastState.dev.port = msg.port; lastState.dev.localUrl = "http://localhost:" + msg.port; }
    lastState.dev.terminalId = msg.terminalId;
  }
  if (isOpen) {
    if (lastState) render(lastState);
    else renderDevOnly(msg);
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
  if (b) b.innerHTML = devSectionHtml({ dev: msg.running ? { status: "running", port: msg.port } : null });
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
      html += '<a class="ws-thumb" data-img="' + url + '" href="' + url + '" target="_blank" rel="noopener" title="' + url + '"><img src="' + url + '" loading="lazy" alt=""></a>';
    } else if (m.type === "video") {
      html += '<a class="ws-thumb ws-thumb-video" href="' + url + '" target="_blank" rel="noopener" title="' + url + '"><i data-lucide="play-circle"></i></a>';
    } else {
      html += '<a class="ws-thumb ws-thumb-link" href="' + url + '" target="_blank" rel="noopener" title="' + url + '"><i data-lucide="paperclip"></i></a>';
    }
  }
  html += '</div>';
  return html;
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
  var links = linkBtn(item.url, typeIcon, (item.type === "pr" ? "PR #" : "#") + item.number);
  if (item.previewUrl) links += linkBtn(item.previewUrl, "external-link", "Preview");
  return '' +
    '<div class="ws-item">' +
      '<div class="ws-item-head">' +
        '<span class="ws-item-title"><i data-lucide="' + typeIcon + '"></i>' + escapeHtml(item.title || ("#" + item.number)) + '</span>' +
        stateChip(item.state) +
        '<button class="ws-pin-btn" data-pin="' + escapeHtml(item.slug || "") + '#' + item.number + '" data-pinned="' + (item.pinned ? "1" : "0") + '" title="' + pinTitle + '"><i data-lucide="' + pinIcon + '"></i></button>' +
      '</div>' +
      labels +
      '<div class="ws-linkrow">' + links + '</div>' +
      mediaThumbsHtml(item.media) +
    '</div>';
}

function devSectionHtml(state) {
  var dev = state.dev;
  if (!dev) {
    return '<div class="ws-section"><div class="ws-section-title">Local environment</div>' +
      '<div class="ws-empty-sm">No dev script detected in package.json.</div></div>';
  }
  var status = dev.status || "stopped";
  var dotCls = status === "running" ? "ws-dot-on" : status === "starting" ? "ws-dot-warn" : "ws-dot-off";
  var btnLabel = (status === "stopped") ? "Start dev server" : "Stop dev server";
  var btnAction = (status === "stopped") ? "start" : "stop";
  var btnIcon = (status === "stopped") ? "play" : "square";
  var localLink = dev.localUrl && status !== "stopped"
    ? '<a class="ws-linkbtn" href="' + escapeHtml(dev.localUrl) + '" target="_blank" rel="noopener"><i data-lucide="external-link"></i>' + escapeHtml(dev.localUrl) + '</a>'
    : '<span class="ws-muted">' + escapeHtml(dev.localUrl || "") + '</span>';
  return '' +
    '<div class="ws-section">' +
      '<div class="ws-section-title">Local environment</div>' +
      '<div class="ws-kv"><span class="ws-k">Script</span><span class="ws-v"><code>' + escapeHtml(dev.command || dev.script || "") + '</code></span></div>' +
      '<div class="ws-kv"><span class="ws-k">Port</span><span class="ws-v">' + escapeHtml(String(dev.port || "—")) + '</span></div>' +
      '<div class="ws-kv"><span class="ws-k">Status</span><span class="ws-v"><span class="ws-dot ' + dotCls + '"></span>' + escapeHtml(status) + '</span></div>' +
      '<div class="ws-linkrow">' + localLink + '</div>' +
      '<button class="ws-devbtn ws-dev-' + btnAction + '" data-dev="' + btnAction + '"><i data-lucide="' + btnIcon + '"></i>' + btnLabel + '</button>' +
    '</div>';
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
    html += '<div class="ws-section"><div class="ws-section-title">Session screenshots</div>' + mediaThumbsHtml(state.sessionMedia) + '</div>';
  }

  b.innerHTML = html;
  wireBody(b);
  refreshIcons();
}

function wireBody(b) {
  // Image thumbnails open the lightbox.
  var thumbs = b.querySelectorAll(".ws-thumb[data-img]");
  for (var i = 0; i < thumbs.length; i++) {
    thumbs[i].addEventListener("click", function (e) {
      e.preventDefault();
      showImageModal(this.getAttribute("data-img"));
    });
  }
  // Dev start/stop.
  var devBtn = b.querySelector(".ws-devbtn");
  if (devBtn) devBtn.addEventListener("click", function () {
    var action = this.getAttribute("data-dev");
    sendWs({ type: action === "start" ? "workspace_dev_start" : "workspace_dev_stop" });
    this.disabled = true;
  });
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
