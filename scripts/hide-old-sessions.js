#!/usr/bin/env node
// Hide all sessions EXCEPT those listed in keep-list.txt.
// Usage:
//   node scripts/hide-old-sessions.js               # dry-run
//   node scripts/hide-old-sessions.js --apply       # actually edit files
//
// keep-list.txt: one session ID (UUID) per line. Lines starting with # are ignored.
// Sessions whose ID is in the keep list are left as-is; all others get hidden:true
// added to their meta line. Daemon must be stopped before --apply.

var fs = require("fs");
var path = require("path");
var os = require("os");

var root = path.join(os.homedir(), ".clay", "sessions");
var keepFile = path.join(__dirname, "keep-list.txt");
var apply = process.argv.includes("--apply");

if (!fs.existsSync(keepFile)) {
  console.error("Missing " + keepFile + ". Create it with one session ID per line.");
  process.exit(1);
}

var keep = new Set();
var keepLines = fs.readFileSync(keepFile, "utf8").split("\n");
for (var ki = 0; ki < keepLines.length; ki++) {
  var l = keepLines[ki].trim();
  if (l && !l.startsWith("#")) keep.add(l);
}

console.log("Keep list: " + keep.size + " ids");

// Canonical session id: prefer meta.cliSessionId, else the filename WITHOUT the
// .jsonl suffix. Must match clear-today-yesterday.js and the keep-list.
function sessionIdFor(meta, filename) {
  return meta.cliSessionId || filename.replace(/\.jsonl$/, "");
}

var scanned = 0;
var willHide = 0;
var alreadyHidden = 0;
var kept = 0;

var projects = fs.readdirSync(root);
for (var pi = 0; pi < projects.length; pi++) {
  var dir = path.join(root, projects[pi]);
  try {
    if (!fs.statSync(dir).isDirectory()) continue;
  } catch (e) { continue; }
  var files = fs.readdirSync(dir);
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
    try {
      meta = JSON.parse(firstLine);
    } catch (e) {
      continue;
    }
    var id = sessionIdFor(meta, f);
    if (keep.has(id)) {
      kept++;
      continue;
    }
    if (meta.hidden) {
      alreadyHidden++;
      continue;
    }
    willHide++;
    if (apply) {
      meta.hidden = true;
      fs.writeFileSync(fp, JSON.stringify(meta) + rest);
    }
  }
}

console.log("Scanned: " + scanned);
console.log("Keep matches: " + kept);
console.log("Already hidden: " + alreadyHidden);
console.log((apply ? "Hidden" : "Would hide") + ": " + willHide);
if (!apply) console.log("\nDry run. Re-run with --apply to write changes.");
