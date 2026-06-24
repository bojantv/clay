// app-connection.js - WebSocket connection, reconnect, status
// Extracted from app.js (PR-22)

import { store } from './store.js';
import { getWs, setWs } from './ws-ref.js';
import { decideSocketAction, shouldProbeLiveness } from './connection-policy.js';
import { getStatusDot, getSendBtn } from './dom-refs.js';
import { setSendBtnMode, blinkIO, setActivity } from './app-favicon.js';
import { startLogoAnimation, stopLogoAnimation } from './ascii-logo.js';
import { hasSendableContent } from './input.js';
import { processMessage } from './app-messages.js';
import { flushPendingExtMessages } from './app-misc.js';
import { resetTerminals } from './terminal.js';
import { closeDmUserPicker } from './sidebar-mates.js';
import { openDm } from './app-dm.js';

var reconnectTimer = null;
var reconnectDelay = 1000;
var connectTimeoutId = null;
var connectOverlay = null;
var externalSessionSyncEventsAttached = false;
var lastExternalSessionSyncAt = 0;
var lastInteractionProbeAt = 0;
var INTERACTION_PROBE_THROTTLE_MS = 1500;

// Heartbeat: an app-level ping/pong proves the socket is actually alive. After a
// laptop sleep the browser often keeps a "zombie" WebSocket (readyState OPEN but
// dead), so we probe on a timer and on every wake signal, and force a clean
// reconnect the moment a pong doesn't come back.
var heartbeatTimer = null;
var pongTimer = null;
var HEARTBEAT_INTERVAL_MS = 25000;
var PONG_TIMEOUT_MS = 5000;
var WAKE_PONG_TIMEOUT_MS = 2000;

function requestExternalSessionSync(reason) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  var now = Date.now();
  if (now - lastExternalSessionSyncAt < 1000) return;
  lastExternalSessionSyncAt = now;
  try {
    ws.send(JSON.stringify({
      type: "sync_external_session",
      id: store.get('activeSessionId') || null,
      reason: reason || "",
    }));
  } catch (e) {}
}

function attachExternalSessionSyncEvents() {
  if (externalSessionSyncEventsAttached) return;
  externalSessionSyncEventsAttached = true;
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) checkLivenessAfterWake("visible");
  });
  window.addEventListener("focus", function () {
    checkLivenessAfterWake("focus");
  });
  // pageshow fires when the page is restored (incl. from bfcache after wake).
  window.addEventListener("pageshow", function () {
    checkLivenessAfterWake("pageshow");
  });
  // Network came back (e.g. after sleep): the existing socket is usually stale.
  // Verify-then-reconnect (same path as the other wake signals) so a socket that
  // genuinely survived isn't needlessly dropped.
  window.addEventListener("online", function () {
    checkLivenessAfterWake("online");
  });
  // Any user interaction is a chance to catch a dead/zombie socket fast. If the
  // socket is gone we reconnect; if it's OPEN but no pong has come back recently
  // we probe, so a post-sleep/tunnel-drop zombie is caught within the short
  // wake-pong window instead of waiting up to a full heartbeat interval. Without
  // this, clicking around a frozen app (switch session, refresh) did nothing and
  // gave no feedback. Throttled and capture-phase so it costs ~nothing on rapid
  // clicks and runs before the click's own handler.
  document.addEventListener("pointerdown", function () {
    var now = Date.now();
    if (now - lastInteractionProbeAt < INTERACTION_PROBE_THROTTLE_MS) return;
    lastInteractionProbeAt = now;
    checkLivenessAfterWake("interaction");
  }, { capture: true, passive: true });
}

export function initConnection() {
  connectOverlay = document.getElementById("connect-overlay");
  attachExternalSessionSyncEvents();

  // --- Reactive UI sync for connected/processing state ---
  store.subscribe(function (state, prev) {
    // Status dot (depends on both connected and processing)
    if (state.connected !== prev.connected || state.processing !== prev.processing) {
      var dot = getStatusDot();
      if (dot) {
        dot.className = "icon-strip-status";
        if (state.connected) {
          dot.classList.add("connected");
          if (state.processing) dot.classList.add("processing");
        }
      }
    }

    // Connected state changed
    if (state.connected !== prev.connected) {
      var sendBtn = getSendBtn();
      if (state.connected) {
        if (sendBtn) sendBtn.disabled = false;
        if (connectOverlay) connectOverlay.classList.add("hidden");
        var updPill = document.getElementById("update-pill-wrap");
        if (updPill) updPill.classList.add("hidden");
        stopLogoAnimation();
      } else {
        if (sendBtn) sendBtn.disabled = true;
        if (connectOverlay) connectOverlay.classList.remove("hidden");
        startLogoAnimation();
      }
    }

    // Processing state changed
    if (state.processing !== prev.processing) {
      if (state.processing) {
        setSendBtnMode(hasSendableContent() ? "send" : "stop");
      } else if (state.connected) {
        setSendBtnMode("send");
      }
    }
  });
}

// setStatus: now just sets state. UI sync is handled by the subscriber above.
export function setStatus(status) {
  if (status === "connected") {
    store.set({ connected: true, processing: false });
  } else if (status === "processing") {
    store.set({ processing: true });
  } else {
    store.set({ connected: false, processing: false });
  }
}

// Send a user-initiated, socket-backed action (switching sessions, refresh,
// fork, ...). Unlike a bare `if (ws.readyState === 1) ws.send(...)` — which
// SILENTLY DROPS the action when the socket is missing/closing/closed or a dead
// "zombie" — this surfaces the "Reconnecting to server…" overlay and forces a
// fresh connection so the click visibly does something and the app self-heals.
// Returns true only when the action was sent on a live socket.
export function sendUserAction(obj) {
  var ws = getWs();
  if (decideSocketAction(ws ? ws.readyState : -1) === "send") {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      setStatus("disconnected");
      forceReconnect();
      return false;
    }
    // Catch a zombie socket (OPEN but dead) on this interaction rather than
    // waiting up to HEARTBEAT_INTERVAL_MS for the timer-driven probe.
    if (shouldProbeLiveness(Date.now(), store.get('lastPongAt'), HEARTBEAT_INTERVAL_MS, store.get('heartbeatPending'))) {
      sendPing(WAKE_PONG_TIMEOUT_MS);
    }
    return true;
  }
  // Socket not OPEN: recover + show the reconnecting overlay instead of dropping.
  setStatus("disconnected");
  forceReconnect();
  return false;
}

function onConnected() {
  // Flush any extension messages that arrived before WS was ready
  flushPendingExtMessages();

  // Reset terminal xterm instances (server will send fresh term_list)
  resetTerminals();

  // Re-send push subscription on reconnect
  var ws = getWs();
  if (window._pushSubscription) {
    try {
      ws.send(JSON.stringify({
        type: "push_subscribe",
        subscription: window._pushSubscription.toJSON(),
      }));
    } catch(e) {}
  }

  // Request mates list
  try {
    ws.send(JSON.stringify({ type: "mate_list" }));
  } catch(e) {}

  // If connecting to a mate project, request knowledge list for badge
  if (store.get('mateProjectSlug')) {
    try { ws.send(JSON.stringify({ type: "knowledge_list" })); } catch(e) {}
  }

  setTimeout(function () {
    requestExternalSessionSync("connect");
  }, 500);

  // Session restore is now server-driven (user-presence.json).
  // Mate DM restore is also server-driven via "restore_mate_dm" message.
  // Previously there was a 2s localStorage fallback that auto-called
  // openDm(savedDm) on every reconnect. That fallback re-opened stale
  // mate DMs on every refresh / project switch and was the root cause
  // of the skill-install modal popping unprompted. Server-driven restore
  // is authoritative — drop the client-side fallback entirely.
  try { localStorage.removeItem("clay-active-dm"); } catch (e) {}
  // Safety: clear returningFromMateDm after initial messages settle
  if (store.get('returningFromMateDm')) {
    setTimeout(function () {
      if (store.get('returningFromMateDm')) {
        store.set({ returningFromMateDm: false });
      }
    }, 2000);
  }

  startHeartbeat();
}

export function connect() {
  var ws = getWs();
  if (ws) { ws.onclose = null; ws.close(); }
  if (connectTimeoutId) { clearTimeout(connectTimeoutId); connectTimeoutId = null; }

  var protocol = location.protocol === "https:" ? "wss:" : "ws:";
  var newWs = new WebSocket(protocol + "//" + location.host + store.get('wsPath'));
  setWs(newWs);

  // If not connected within 3s, force retry
  connectTimeoutId = setTimeout(function () {
    if (!store.get('connected')) {
      newWs.onclose = null;
      newWs.onerror = null;
      newWs.close();
      connect();
    }
  }, 3000);

  newWs.onopen = function () {
    if (connectTimeoutId) { clearTimeout(connectTimeoutId); connectTimeoutId = null; }
    setStatus("connected");
    reconnectDelay = 1000;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // Wrap ws.send to blink LED on outgoing traffic
    var currentWs = getWs();
    var _origSend = currentWs.send.bind(currentWs);
    currentWs.send = function (data) {
      blinkIO();
      return _origSend(data);
    };

    onConnected();
  };

  newWs.onclose = function (e) {
    if (connectTimeoutId) { clearTimeout(connectTimeoutId); connectTimeoutId = null; }
    stopHeartbeat();
    closeDmUserPicker();
    setStatus("disconnected");
    setActivity(null);
    scheduleReconnect();
  };

  newWs.onerror = function () {};

  newWs.onmessage = function (event) {
    // Backup: if we're receiving messages, we're connected
    if (!store.get('connected')) {
      setStatus("connected");
      reconnectDelay = 1000;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }

    blinkIO();
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    processMessage(msg);
  };
}

export function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

export function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    // Check if auth is still valid before reconnecting
    fetch("/info").then(function (res) {
      if (res.status === 401) {
        location.reload();
        return;
      }
      connect();
    }).catch(function () {
      // Server still down, try connecting anyway
      connect();
    });
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(function () {
    sendPing(PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  store.set({ heartbeatPending: false });
}

function sendPing(pongTimeoutMs) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) { forceReconnect(); return; }
  if (store.get('heartbeatPending')) return; // already awaiting a pong; pongTimer decides the outcome
  store.set({ heartbeatPending: true });
  try {
    ws.send(JSON.stringify({ type: "ping" }));
  } catch (e) {
    forceReconnect();
    return;
  }
  if (pongTimer) clearTimeout(pongTimer);
  pongTimer = setTimeout(function () {
    pongTimer = null;
    if (store.get('heartbeatPending')) forceReconnect(); // no pong came back -> zombie socket
  }, pongTimeoutMs);
}

// Called when the server's pong arrives (routed from app-messages.js).
export function onPong() {
  store.set({ heartbeatPending: false, lastPongAt: Date.now() });
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

// Tear down a (possibly dead) socket and reconnect immediately, resetting the
// backoff so a wake reconnect is instant rather than laddered.
function forceReconnect() {
  stopHeartbeat();
  reconnectDelay = 1000;
  cancelReconnect();
  var ws = getWs();
  if (ws) {
    // Suppress the close handler so it doesn't also schedule a reconnect.
    try { ws.onclose = null; ws.close(); } catch (e) {}
  }
  connect();
}

// Run on every wake signal. If a connect is already in flight, let it settle
// (the 3s connect-timeout guard covers a stuck handshake). If the socket is
// gone/closing, reconnect now. If it's open, verify with a tight pong window —
// a zombie socket fails that and triggers forceReconnect.
function checkLivenessAfterWake(reason) {
  var ws = getWs();
  if (ws && ws.readyState === 0) return; // CONNECTING: a connect is already in flight
  if (!ws || ws.readyState !== 1) { forceReconnect(); return; } // missing / closing / closed
  sendPing(WAKE_PONG_TIMEOUT_MS);
  requestExternalSessionSync(reason);
}
