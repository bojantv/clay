#!/usr/bin/env node
// Delete sessions in the UI's Today + Yesterday buckets (matches the sidebar's
// "Clear" button for those groups). Uses mtime, which is what the daemon uses
// for lastActivity / group assignment. Keeps This Week + Older intact.
//
// Usage:
//   node scripts/clear-today-yesterday.js           # dry-run
//   node scripts/clear-today-yesterday.js --apply   # actually delete files
//
// Stop the daemon before --apply.

var fs = require("fs");
var path = require("path");
var os = require("os");

var root = path.join(os.homedir(), ".clay", "sessions");
var apply = process.argv.includes("--apply");

var keepFile = path.join(__dirname, "keep-list.txt");
var keep = new Set();
if (fs.existsSync(keepFile)) {
  var lines = fs.readFileSync(keepFile, "utf8").split("\n");
  for (var li = 0; li < lines.length; li++) {
    var t = lines[li].trim();
    if (t && !t.startsWith("#")) keep.add(t);
  }
}
console.log("Keep list: " + keep.size + " ids");

// Canonical session id: prefer meta.cliSessionId, else the filename WITHOUT the
// .jsonl suffix. Must match hide-old-sessions.js and the keep-list (UUID form),
// otherwise a kept session could be deleted.
function sessionIdFor(meta, filename) {
  return meta.cliSessionId || filename.replace(/\.jsonl$/, "");
}

function getDateGroup(ts) {
  var now = new Date();
  var d = new Date(ts);
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var yesterday = new Date(today.getTime() - 86400000);
  var weekAgo = new Date(today.getTime() - 7 * 86400000);
  if (d >= today) return "Today";
  if (d >= yesterday) return "Yesterday";
  if (d >= weekAgo) return "This Week";
  return "Older";
}

var buckets = { Today: [], Yesterday: [], "This Week": [], Older: [] };

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
    try {
      var st = fs.statSync(fp);
      var fd = fs.openSync(fp, "r");
      var buf = Buffer.alloc(4096);
      var n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      var firstLine = buf.toString("utf8", 0, n).split("\n")[0];
      var meta = JSON.parse(firstLine);
      var grp = getDateGroup(st.mtimeMs);
      buckets[grp].push({
        fp: fp,
        title: meta.title || "(untitled)",
        id: sessionIdFor(meta, f),
        bookmarked: !!meta.bookmarked,
      });
    } catch (e) {}
  }
}

var groupKeys = Object.keys(buckets);
for (var gi = 0; gi < groupKeys.length; gi++) {
  console.log(groupKeys[gi] + ": " + buckets[groupKeys[gi]].length);
}

var candidates = buckets.Today.concat(buckets.Yesterday);
var toDelete = candidates.filter(function (s) {
  return !keep.has(s.id) && !s.bookmarked;
});
var total = buckets.Today.length + buckets.Yesterday.length;
var skipped = total - toDelete.length;
console.log("\nKeep-list + bookmarked skipped: " + skipped);
console.log("Will " + (apply ? "DELETE" : "(dry-run) delete") + ": " + toDelete.length + " sessions");
if (toDelete.length && !apply) {
  console.log("\nSample of first 15:");
  var sample = toDelete.slice(0, 15);
  for (var si = 0; si < sample.length; si++) console.log("  " + sample[si].id + "  " + sample[si].title);
  console.log("\nDry run. Re-run with --apply to actually delete.");
}
if (apply) {
  for (var di = 0; di < toDelete.length; di++) {
    try {
      fs.unlinkSync(toDelete[di].fp);
    } catch (e) {
      console.error("Failed to delete " + toDelete[di].fp + ": " + e.message);
    }
  }
  console.log("Deleted " + toDelete.length + " files.");
}
