#!/usr/bin/env node
// Hide sessions that were auto-adopted from leftover handoff rollouts.
// A vendor/model handoff leaves a secondary CLI rollout whose first user
// message is the injected handoff context; older builds auto-adopted these as
// brand-new sessions titled "[Context from previous ... conversation". This
// hides them (sets hidden:true on the meta line) so they leave the sidebar.
//
// Usage:
//   node scripts/hide-handoff-sessions.js            # dry-run (default)
//   node scripts/hide-handoff-sessions.js --apply    # actually edit files
//
// Stop the Clay daemon before running with --apply, otherwise the daemon may
// overwrite the edited meta line.

var fs = require("fs");
var path = require("path");
var os = require("os");

var root = path.join(os.homedir(), ".clay", "sessions");
var apply = process.argv.includes("--apply");

// True when the session looks like an adopted handoff rollout: the title or the
// first user message carries the handoff marker (current tag or legacy wording).
function isHandoffSession(meta, content) {
  var title = String((meta && meta.title) || "");
  if (title.indexOf("<clay_handoff_context>") !== -1) return true;
  if (title.indexOf("Context from previous") !== -1) return true;
  var head = String(content || "").slice(0, 4000);
  if (head.indexOf("<clay_handoff_context>") !== -1) return true;
  if (head.indexOf("[Context from previous") !== -1) return true;
  return false;
}

var scanned = 0;
var willHide = 0;
var alreadyHidden = 0;
var samples = [];

var projects;
try {
  projects = fs.readdirSync(root);
} catch (e) {
  console.error("No sessions directory at " + root);
  process.exit(1);
}

for (var pi = 0; pi < projects.length; pi++) {
  var dir = path.join(root, projects[pi]);
  try {
    if (!fs.statSync(dir).isDirectory()) continue;
  } catch (e) { continue; }
  var files;
  try { files = fs.readdirSync(dir); } catch (e) { continue; }
  for (var fi = 0; fi < files.length; fi++) {
    var f = files[fi];
    if (!f.endsWith(".jsonl")) continue;
    var fp = path.join(dir, f);
    scanned++;
    var content;
    try { content = fs.readFileSync(fp, "utf8"); } catch (e) { continue; }
    var nl = content.indexOf("\n");
    var firstLine = nl === -1 ? content : content.slice(0, nl);
    var rest = nl === -1 ? "" : content.slice(nl);
    var meta;
    try { meta = JSON.parse(firstLine); } catch (e) { continue; }
    if (!isHandoffSession(meta, content)) continue;
    if (meta.hidden) { alreadyHidden++; continue; }
    willHide++;
    if (samples.length < 12) samples.push(String(meta.title || f).slice(0, 60));
    if (apply) {
      meta.hidden = true;
      fs.writeFileSync(fp, JSON.stringify(meta) + rest);
    }
  }
}

console.log("Scanned: " + scanned);
console.log("Already hidden: " + alreadyHidden);
console.log((apply ? "Hidden" : "Would hide") + ": " + willHide);
if (samples.length > 0) {
  console.log("\nMatched titles:");
  for (var si = 0; si < samples.length; si++) console.log("  - " + samples[si]);
}
if (!apply) console.log("\nDry run. Stop the Clay daemon, then re-run with --apply to write changes.");
