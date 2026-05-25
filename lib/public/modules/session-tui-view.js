// session-tui-view.js
//
// Renders a Claude Code TUI inside the main session view area when the
// active session is a `mode: 'tui'` session. The PTY itself is managed by
// the server's terminal-manager (same infra that powers the bottom-panel
// shell tabs); this module is responsible only for the embedded xterm and
// for relaying input/output/resize for the bound terminal.
//
// Lifecycle (driven by app-messages.js on session_switched):
//   attachTuiView(terminalId)  - mount xterm, send term_attach
//   detachTuiView()            - send term_detach, dispose xterm
//
// PTY survives detach (server keeps the terminal alive). On `/exit` or
// claude exit the server's onExit hook deletes the session and broadcasts
// the new session list; this view tears itself down via handleTermExited.

import { getWs } from './ws-ref.js';
import { store } from './store.js';
import { getTerminalTheme } from './theme.js';
import { getTerminalFontFamily, getTerminalFontSize, onTerminalFontChange } from './terminal-prefs.js';
import { openArticle as openWhatsNewArticle } from './whats-new-article.js';

// Stable id of the canonical "Why TUI mode?" article in
// lib/whats-new-content.js. The TUI policy notice's "Learn more" button
// opens that article in the blog viewer instead of a one-off modal.
var TUI_POLICY_ARTICLE_ID = "2026-06-tui-default";

// Claude TUI session terminal colors follow Clay's active theme via
// getTerminalTheme(). Live theme switches are wired through
// setTuiSessionTheme() below, which theme.js calls from applyTheme.

var hostEl = null;       // container div mounted over #messages
var xtermContainerEl = null;

// The TUI policy notice's "Learn more" button opens the canonical
// "Why TUI mode?" entry in the What's New blog viewer. The full
// authoritative text lives in lib/whats-new-content.js so there's a
// single source of truth.
function openPolicyArticle(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  openWhatsNewArticle(TUI_POLICY_ARTICLE_ID);
}

var xterm = null;        // xterm.js instance
var fitAddon = null;
var webglAddon = null;
var currentTermId = null;
var resizeObserver = null;
var windowResizeBound = false;
var resizeDebounce = null;
// Debounced fit+redraw: collapses a stream of resize events (60fps drag)
// into a single SIGWINCH/refresh pair at the end. Without this the TUI
// gets corrupted because claude starts redrawing at intermediate sizes
// before the user finishes resizing.
//
// The end-of-debounce sequence is intentionally split across two rAFs:
//
//   1. syncHostBounds() mutates hostEl.style.width. The xterm container
//      width derives from that via flex layout. We must wait one frame
//      so the style change has been applied to layout before
//      fitAddon.fit() reads clientWidth - otherwise fit() can compute
//      cols against the pre-resize container width.
//   2. A second rAF + second fit() pass converges any further layout
//      adjustments (scrollbar appear/disappear, policy notice
//      reflowing on narrower widths, etc.). This mirrors the two-pass
//      fit used on attach (fitNow + setTimeout(fitNow, 50)).
//   3. WebGL renderer caches a font atlas keyed on cell metrics. When
//      cell size shifts on resize the atlas can desync, producing the
//      "width looks broken" artifacts. clearTextureAtlas() forces a
//      rebuild so glyphs are re-rasterized at the new metrics.
function scheduleResize() {
  if (currentTermId == null) return;
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(function () {
    resizeDebounce = null;
    syncHostBounds();
    requestAnimationFrame(function () {
      fitNow();
      requestAnimationFrame(function () {
        fitNow();
        if (webglAddon && typeof webglAddon.clearTextureAtlas === "function") {
          try { webglAddon.clearTextureAtlas(); } catch (e) {}
        }
        if (xterm) {
          try { xterm.refresh(0, xterm.rows - 1); } catch (e) {}
        }
      });
    });
  }, 120);
}
function onWindowResize() { scheduleResize(); }

function ensureHostEl() {
  if (hostEl) return hostEl;
  // Anchor the host to the chat content area (the bounding box of
  // #messages) rather than the viewport. Using `position: fixed` worked
  // visually but broke layout when the sidebar, header, or any side panel
  // was open - the xterm slid under them. Re-position on every show via
  // syncHostBounds() so resizes and panel toggles stay in sync.
  hostEl = document.createElement("div");
  hostEl.id = "tui-session-host";
  hostEl.style.position = "fixed";
  hostEl.style.display = "none";
  hostEl.style.flexDirection = "column";
  hostEl.style.background = "#000000";
  hostEl.style.zIndex = "5";
  hostEl.style.overflow = "hidden";
  hostEl.style.boxSizing = "border-box";
  // 4px inset on all sides so the terminal doesn't kiss the edges of the
  // content area. fitAddon computes against the xterm container's
  // clientWidth/clientHeight (which exclude padding + the policy banner),
  // so cols/rows stay correct.
  hostEl.style.padding = "4px";

  // Policy notice: explains why TUI mode exists (Anthropic split Agent
  // SDK usage into a separate billing bucket on 2026-06-15; running
  // `claude` in a real terminal keeps usage in the Interactive bucket).
  var noticeEl = document.createElement("div");
  noticeEl.className = "tui-policy-notice";
  noticeEl.innerHTML =
    '<span class="tui-policy-icon">●</span>' +
    '<span class="tui-policy-text">TUI is the default Claude mode in Clay because of Anthropic\'s new billing policy.</span>' +
    '<button type="button" class="tui-policy-learn-more">Learn more</button>' +
    '<button type="button" class="tui-policy-dismiss" aria-label="Dismiss this notice for the rest of the page">&times;</button>';
  noticeEl.querySelector(".tui-policy-learn-more").addEventListener("click", openPolicyArticle);
  noticeEl.querySelector(".tui-policy-dismiss").addEventListener("click", function () {
    // Session-only dismiss: hides the notice for the current page load.
    // Reloading restores it on purpose so the policy context doesn't
    // get lost forever - a user who comes back next month should be
    // re-reminded that TUI is a billing workaround.
    noticeEl.style.display = "none";
    if (typeof fitNow === "function") fitNow();
  });
  hostEl.appendChild(noticeEl);

  // Dedicated xterm container so the banner sits above the terminal
  // rather than xterm mounting at the host root (which would have it
  // side-by-side with the banner under flex layout).
  xtermContainerEl = document.createElement("div");
  xtermContainerEl.className = "tui-xterm-container";
  xtermContainerEl.style.flex = "1 1 auto";
  xtermContainerEl.style.minHeight = "0";
  xtermContainerEl.style.position = "relative";
  hostEl.appendChild(xtermContainerEl);

  // Paste-image handling. Two paths cover the common platforms:
  //
  //   1. `paste` event in capture phase - covers Cmd+V on macOS and
  //      Ctrl+V on Win/Linux, where the browser fires a paste event
  //      with clipboardData populated.
  //   2. `keydown` for Ctrl+V (no Meta) in capture phase - macOS does
  //      not fire `paste` for Ctrl+V (Ctrl isn't the OS paste modifier
  //      there), so the keystroke would otherwise reach claude CLI
  //      directly. We read the system clipboard via the async
  //      Clipboard API instead.
  //
  // In both paths an image hit is uploaded to /api/upload (same
  // endpoint the GUI input uses) and the returned absolute path is
  // injected as text into the PTY; claude CLI accepts file paths as
  // prompt input. Capture phase + stopImmediatePropagation keep xterm
  // from also processing the event (which would paste the filename
  // text alongside the path).
  hostEl.addEventListener("paste", handleTuiPaste, true);
  hostEl.addEventListener("keydown", handleTuiCtrlV, true);

  document.body.appendChild(hostEl);
  return hostEl;
}

function handleTuiCtrlV(e) {
  // Only handle plain Ctrl+V (no Meta/Alt/Shift). Cmd+V on macOS is
  // covered by the paste event handler. Without this intercept on macOS
  // a Ctrl+V keystroke would just be forwarded to claude CLI's own
  // paste path, which can't read image data out of the system
  // clipboard reliably ("no image found in clipboard").
  if (e.key !== "v" || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (currentTermId == null) return;
  if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") return;

  // Stop the keystroke from also reaching xterm / the PTY. We take full
  // ownership of paste semantics: image -> upload + inject path, text
  // -> forward via term_input, nothing -> no-op.
  e.preventDefault();
  e.stopImmediatePropagation();

  navigator.clipboard.read().then(function (items) {
    for (var i = 0; i < items.length; i++) {
      var imgType = null;
      for (var t = 0; t < items[i].types.length; t++) {
        if (items[i].types[t].indexOf("image/") === 0) { imgType = items[i].types[t]; break; }
      }
      if (imgType) {
        items[i].getType(imgType).then(uploadAndInjectPath).catch(function () {});
        return; // handle the first image found
      }
    }
    // No image - fall back to text paste behavior.
    if (typeof navigator.clipboard.readText === "function") {
      navigator.clipboard.readText().then(function (text) {
        if (!text || currentTermId == null) return;
        var ws = getWs();
        if (!ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: "term_input", id: currentTermId, data: text }));
      }).catch(function () {});
    }
  }).catch(function () {
    // Permission denied or unsupported - silently fail. xterm received
    // no keystroke either because we already stopped propagation, so
    // the user can press the key again to retry.
  });
}

function handleTuiPaste(e) {
  var cd = e.clipboardData;
  if (!cd || currentTermId == null) return;

  // Collect image blobs from both cd.files (Safari/iOS friendly) and
  // cd.items. Plain-text-only paste is left untouched so xterm's built-in
  // text paste keeps working.
  var blobs = [];
  if (cd.files && cd.files.length > 0) {
    for (var i = 0; i < cd.files.length; i++) {
      if (cd.files[i] && cd.files[i].type.indexOf("image/") === 0) blobs.push(cd.files[i]);
    }
  }
  if (blobs.length === 0 && cd.items) {
    for (var j = 0; j < cd.items.length; j++) {
      if (cd.items[j] && cd.items[j].type && cd.items[j].type.indexOf("image/") === 0) {
        var b = cd.items[j].getAsFile();
        if (b) blobs.push(b);
      }
    }
  }
  if (blobs.length === 0) return; // text or other - let xterm handle

  // Stop xterm's textarea from also seeing this event and pasting the
  // file's text representation (filename) alongside our injected path.
  e.preventDefault();
  e.stopImmediatePropagation();
  for (var k = 0; k < blobs.length; k++) {
    uploadAndInjectPath(blobs[k]);
  }
}

function uploadAndInjectPath(blob) {
  var ext = ".png";
  if (blob.type === "image/jpeg") ext = ".jpg";
  else if (blob.type === "image/gif") ext = ".gif";
  else if (blob.type === "image/webp") ext = ".webp";
  var name = blob.name || ("pasted-" + Date.now() + ext);

  var reader = new FileReader();
  reader.onload = function (ev) {
    var dataUrl = ev.target.result;
    var commaIdx = dataUrl.indexOf(",");
    var b64 = commaIdx !== -1 ? dataUrl.substring(commaIdx + 1) : "";
    var basePath = store.get("basePath") || "/";
    var xhr = new XMLHttpRequest();
    xhr.open("POST", basePath + "api/upload");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      try {
        var resp = JSON.parse(xhr.responseText);
        if (!resp || !resp.path || currentTermId == null) return;
        var ws = getWs();
        if (!ws || ws.readyState !== 1) return;
        // Wrap in double quotes if the path contains whitespace so the
        // shell / claude CLI treats it as a single token.
        var injected = /\s/.test(resp.path) ? '"' + resp.path + '"' : resp.path;
        ws.send(JSON.stringify({ type: "term_input", id: currentTermId, data: injected }));
      } catch (e) {}
    };
    xhr.send(JSON.stringify({ name: name, data: b64 }));
  };
  reader.readAsDataURL(blob);
}

function syncHostBounds() {
  if (!hostEl) return;
  var messagesEl = document.getElementById("messages");
  if (!messagesEl) return;
  var r = messagesEl.getBoundingClientRect();
  // Extend down to the bottom of the viewport so the empty band that used
  // to sit below #messages (where #input-area lived before we hid it) gets
  // covered by the same terminal background instead of showing through.
  hostEl.style.top = r.top + "px";
  hostEl.style.left = r.left + "px";
  hostEl.style.width = r.width + "px";
  hostEl.style.height = (window.innerHeight - r.top) + "px";
}

function hideGuiChrome(hide) {
  var messagesEl = document.getElementById("messages");
  var inputArea = document.getElementById("input-area");
  if (messagesEl) messagesEl.style.visibility = hide ? "hidden" : "";
  if (inputArea) inputArea.style.display = hide ? "none" : "";
  var newMsgBtn = document.getElementById("new-msg-btn");
  if (newMsgBtn) newMsgBtn.style.display = hide ? "none" : "";
}

function fitNow() {
  if (!xterm || !fitAddon || !hostEl) return;
  syncHostBounds();
  try {
    fitAddon.fit();
    // Inform the server so its PTY's idea of cols/rows matches what xterm
    // just rendered. Without this, claude TUI redraws using stale dims.
    if (currentTermId != null && getWs() && getWs().readyState === 1) {
      getWs().send(JSON.stringify({
        type: "term_resize",
        id: currentTermId,
        cols: xterm.cols,
        rows: xterm.rows,
      }));
    }
  } catch (e) {}
}

function createXterm() {
  if (typeof Terminal === "undefined") return null;
  var theme = getTerminalTheme();
  // Match the host background to the xterm theme so any sub-cell gap
  // between the last rendered row and the host's bottom blends in.
  if (hostEl) hostEl.style.background = theme.background;
  var term = new Terminal({
    cursorBlink: true,
    fontSize: getTerminalFontSize(),
    fontFamily: getTerminalFontFamily(),
    theme: theme,
    scrollback: 5000,
  });
  if (typeof FitAddon !== "undefined") {
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }
  if (typeof WebLinksAddon !== "undefined") {
    try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
  }
  term.open(xtermContainerEl || hostEl);
  if (typeof WebglAddon !== "undefined") {
    try {
      webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(function () {
        try { webglAddon.dispose(); } catch (e) {}
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch (e) {}
  }
  // Route keystrokes back to the PTY.
  term.onData(function (data) {
    if (currentTermId == null) return;
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "term_input", id: currentTermId, data: data }));
    }
  });
  return term;
}

function teardownXterm() {
  if (webglAddon) {
    try { webglAddon.dispose(); } catch (e) {}
    webglAddon = null;
  }
  if (xterm) {
    try { xterm.dispose(); } catch (e) {}
    xterm = null;
  }
  fitAddon = null;
}

export function attachTuiView(terminalId) {
  if (typeof terminalId !== "number") return;
  // Re-attaching to the same terminal: just refit and refocus.
  if (currentTermId === terminalId && xterm) {
    if (hostEl) hostEl.style.display = "flex";
    hideGuiChrome(true);
    fitNow();
    try { xterm.focus(); } catch (e) {}
    return;
  }
  // Switching to a different TUI terminal: tear down the old one cleanly.
  if (currentTermId != null && currentTermId !== terminalId) {
    detachTuiView();
  }
  if (!ensureHostEl()) return;
  hostEl.style.display = "flex";
  hideGuiChrome(true);
  syncHostBounds();

  currentTermId = terminalId;
  if (!xterm) xterm = createXterm();
  if (!xterm) return;

  // Subscribe to the terminal's output stream on the server. The server
  // replays its scrollback buffer on attach so we never start blank.
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "term_attach", id: terminalId }));
  }

  // First fit pass; defer a second pass for layout to settle.
  fitNow();
  setTimeout(fitNow, 50);
  try { xterm.focus(); } catch (e) {}

  if (!resizeObserver && typeof ResizeObserver !== "undefined") {
    // Watch the chat-content area, not the host: the host's size is
    // derived from #messages via syncHostBounds, so observing it would
    // miss the actual source of truth (sidebar toggles, panel opens, etc.)
    var msgEl = document.getElementById("messages");
    if (msgEl) {
      resizeObserver = new ResizeObserver(function () { scheduleResize(); });
      resizeObserver.observe(msgEl);
    }
  }
  if (!windowResizeBound) {
    window.addEventListener("resize", onWindowResize);
    windowResizeBound = true;
  }
}

export function detachTuiView() {
  if (resizeObserver) {
    try { resizeObserver.disconnect(); } catch (e) {}
    resizeObserver = null;
  }
  if (currentTermId != null) {
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: "term_detach", id: currentTermId })); } catch (e) {}
    }
  }
  currentTermId = null;
  teardownXterm();
  if (hostEl) hostEl.style.display = "none";
  hideGuiChrome(false);
}

// Route a term_output frame to the embedded xterm if it belongs to the
// current TUI session. Returns true if consumed so app-messages can skip
// the bottom-panel handler.
export function tuiHandleTermOutput(msg) {
  if (!msg || msg.id !== currentTermId || !xterm || !msg.data) return false;
  xterm.write(msg.data);
  return true;
}

export function tuiHandleTermResized(msg) {
  if (!msg || msg.id !== currentTermId || !xterm) return false;
  if (msg.cols > 0 && msg.rows > 0) {
    try { xterm.resize(msg.cols, msg.rows); } catch (e) {}
  }
  return true;
}

export function tuiHandleTermExited(msg) {
  if (!msg || msg.id !== currentTermId) return false;
  if (xterm) {
    try { xterm.write("\r\n\x1b[90m[claude exited - session will close]\x1b[0m\r\n"); } catch (e) {}
  }
  // The server's onExit hook deletes the session record and broadcasts a
  // fresh session_list. The next session_switched (or empty state) will
  // call detachTuiView for us.
  return true;
}

export function tuiHandleTermClosed(msg) {
  if (!msg || msg.id !== currentTermId) return false;
  detachTuiView();
  return true;
}

export function getActiveTuiTerminalId() {
  return currentTermId;
}

// Live theme update. Called by theme.js applyTheme() whenever the user
// switches themes - rewrites xterm colors in place and re-syncs the
// host background so transitions are seamless without re-mounting the
// PTY.
export function setTuiSessionTheme(xtermTheme) {
  if (xterm) {
    try { xterm.options.theme = xtermTheme; } catch (e) {}
  }
  if (hostEl && xtermTheme && xtermTheme.background) {
    hostEl.style.background = xtermTheme.background;
  }
}

// Live font update. Cell metrics shift with font size, so we refit
// after applying and let the existing resize debounce notify the PTY
// of the new cols/rows.
onTerminalFontChange(function (family, size) {
  if (!xterm) return;
  try {
    if (family) xterm.options.fontFamily = family;
    if (size) xterm.options.fontSize = size;
  } catch (e) {}
  scheduleResize();
});
