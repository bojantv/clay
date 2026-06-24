// connection-policy.js — pure WebSocket action policy.
//
// No DOM / WebSocket / store dependencies on purpose: this is the decision core
// behind app-connection.js's sendUserAction() and zombie detection, kept pure so
// it can be unit-tested in node (see test/connection-policy.test.js).
//
// Background: a bare `if (ws.readyState === 1) ws.send(...)` silently DROPS a
// user action when the socket is missing, connecting, closing, closed, or a
// post-sleep "zombie" (readyState OPEN but the connection is actually dead). The
// app then looks frozen — switching sessions shows stale data, the refresh
// button does nothing — with zero feedback. These helpers decide when to send
// vs. recover, and when to probe a possibly-dead socket.

// WebSocket.readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED.
//
// Returns:
//   "send"      — socket is OPEN; send the action now.
//   "reconnect" — socket is not OPEN; recover and surface the reconnecting
//                 state instead of silently dropping the action.
export function decideSocketAction(readyState) {
  return readyState === 1 ? "send" : "reconnect";
}

// Decide whether to fire a liveness probe (app-level ping) to catch a "zombie"
// socket — one that reports OPEN but is actually dead. Probe only when we have
// not heard a pong within the heartbeat window and a probe is not already in
// flight. Triggered on user interaction so a dead socket is caught within the
// short wake-pong window instead of waiting up to a full heartbeat interval.
export function shouldProbeLiveness(nowMs, lastPongAtMs, heartbeatIntervalMs, probePending) {
  if (probePending) return false;
  return (nowMs - (lastPongAtMs || 0)) > heartbeatIntervalMs;
}
