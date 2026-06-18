#!/usr/bin/env node
// One-time history migration: relabel auto-injected "continue" turns.
//
// Older builds recorded auto-continue / auto-resume turns as a literal
// `{type:"user_message", text:"continue"}` entry, so transcripts show a
// "continue" the user never typed. Going forward these are recorded with a
// clear label; this script retro-fits old session files.
//
// SAFETY: only entries that are unambiguously machine-generated are touched:
//   - user_message "continue" immediately preceded by a scheduled_message_sent
//     (the auto-continue timer emits that event right before the turn).
//   - scheduled_message_queued "continue" previews (only scheduleMessage emits
//     this event type).
// A user who literally typed "continue" is preceded by a delta/done/etc., never
// scheduled_message_sent, so those are left untouched.
//
// Usage:
//   node scripts/relabel-continue-history.js            # dry run (default)
//   node scripts/relabel-continue-history.js --apply     # rewrite files (+ .bak)
//
// Stop the daemon before --apply so an in-memory session can't re-save the old
// text over the migrated file.

var fs = require("fs");
var path = require("path");
var config = require("../lib/config");

var LABEL = "↻ Auto-continued";
var apply = process.argv.indexOf("--apply") !== -1;
var base = path.join(config.CONFIG_DIR, "sessions");

function isAutoContinueUserMessage(obj, prev) {
  return obj && obj.type === "user_message" && obj.text === "continue"
    && prev && prev.type === "scheduled_message_sent";
}

function isAutoContinueQueuedPreview(obj) {
  return obj && obj.type === "scheduled_message_queued" && obj.text === "continue";
}

function migrateFile(filePath) {
  var raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { return { changed: 0 }; }

  var lines = raw.split("\n");
  var outLines = [];
  var parsed = [];
  var i;
  // First pass: parse every non-empty line so we can look back at the previous
  // event when deciding whether a "continue" is machine-generated.
  for (i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) { parsed.push(null); continue; }
    try { parsed.push(JSON.parse(lines[i])); }
    catch (e) { parsed.push(undefined); } // undefined = unparseable, keep verbatim
  }

  var changed = 0;
  var prevParsed = null;
  for (i = 0; i < lines.length; i++) {
    var obj = parsed[i];
    if (obj === null) { outLines.push(lines[i]); continue; }          // blank line
    if (obj === undefined) { outLines.push(lines[i]); prevParsed = null; continue; } // unparseable: leave as-is

    if (isAutoContinueUserMessage(obj, prevParsed) || isAutoContinueQueuedPreview(obj)) {
      obj.text = LABEL;
      outLines.push(JSON.stringify(obj));
      changed++;
    } else {
      outLines.push(lines[i]);
    }
    prevParsed = obj;
  }

  if (changed > 0 && apply) {
    fs.copyFileSync(filePath, filePath + ".bak-continue-migration");
    var tmp = filePath + ".tmp-continue-migration";
    fs.writeFileSync(tmp, outLines.join("\n"));
    fs.renameSync(tmp, filePath);
  }
  return { changed: changed };
}

function main() {
  var dirs;
  try { dirs = fs.readdirSync(base); }
  catch (e) { console.error("No sessions directory at " + base); process.exit(1); }

  var totalFiles = 0;
  var touchedFiles = 0;
  var totalChanged = 0;
  var di, fi;
  for (di = 0; di < dirs.length; di++) {
    var dir = path.join(base, dirs[di]);
    var st;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    var files = fs.readdirSync(dir);
    for (fi = 0; fi < files.length; fi++) {
      if (!files[fi].endsWith(".jsonl")) continue;
      totalFiles++;
      var res = migrateFile(path.join(dir, files[fi]));
      if (res.changed > 0) {
        touchedFiles++;
        totalChanged += res.changed;
        console.log((apply ? "[apply] " : "[dry]   ") + res.changed + "  " + path.join(dirs[di], files[fi]));
      }
    }
  }

  console.log("");
  console.log("Files scanned:   " + totalFiles);
  console.log("Files affected:  " + touchedFiles);
  console.log("Entries relabeled: " + totalChanged + " -> \"" + LABEL + "\"");
  if (!apply) {
    console.log("");
    console.log("Dry run only. Re-run with --apply to write (creates .bak-continue-migration backups).");
  }
}

main();
