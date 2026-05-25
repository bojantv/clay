// terminal-prefs.js
//
// Single source of truth for terminal font preferences (family + size).
// Every xterm in Clay (bottom shell panel, Claude TUI session view, TUI
// attention modal) reads from here on create and re-applies on the
// `font-change` event so live updates are seamless.
//
// Persistence lives server-side under the user's profile. This module
// keeps a synchronized in-memory copy that the rest of the client reads
// without round-trips.

var DEFAULT_FAMILY = "'SF Mono', Menlo, Monaco, 'Courier New', monospace";
var DEFAULT_SIZE = 13;

var currentFamily = DEFAULT_FAMILY;
var currentSize = DEFAULT_SIZE;
var listeners = [];

export function getTerminalFontFamily() {
  return currentFamily || DEFAULT_FAMILY;
}

export function getTerminalFontSize() {
  var n = Number(currentSize);
  return (n >= 9 && n <= 32) ? n : DEFAULT_SIZE;
}

export function getDefaultTerminalFontFamily() {
  return DEFAULT_FAMILY;
}

// Set the in-memory values and notify subscribers. Pass null/undefined
// for any field that should stay unchanged. Persisting to the server
// is the caller's responsibility - this only updates local UI.
export function applyTerminalFont(family, size) {
  var changed = false;
  if (typeof family === "string" && family.trim() && family !== currentFamily) {
    currentFamily = family;
    changed = true;
  }
  if (typeof size === "number" && size >= 9 && size <= 32 && size !== currentSize) {
    currentSize = Math.round(size);
    changed = true;
  }
  if (!changed) return;
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](currentFamily, currentSize); } catch (e) {}
  }
}

export function onTerminalFontChange(fn) {
  if (typeof fn === "function") listeners.push(fn);
}
