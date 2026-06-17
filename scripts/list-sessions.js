#!/usr/bin/env node
// List all sessions with title, id, project, mtime, hidden
var fs = require("fs");
var path = require("path");
var os = require("os");

var root = path.join(os.homedir(), ".clay", "sessions");
var rows = [];

var projects = fs.readdirSync(root);
for (var pi = 0; pi < projects.length; pi++) {
  var proj = projects[pi];
  var dir = path.join(root, proj);
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
      rows.push({
        id: meta.cliSessionId || f.replace(/\.jsonl$/, ""),
        title: meta.title || "(untitled)",
        project: proj,
        mtime: st.mtimeMs,
        hidden: !!meta.hidden,
        path: fp,
      });
    } catch (e) {}
  }
}

rows.sort(function (a, b) { return b.mtime - a.mtime; });
var arg = process.argv[2];
var limit = arg ? parseInt(arg, 10) : 30;
var shown = rows.slice(0, limit);
for (var ri = 0; ri < shown.length; ri++) {
  var r = shown[ri];
  var flag = r.hidden ? "H" : "-";
  var d = new Date(r.mtime).toISOString().slice(0, 16);
  var proj2 = r.project.length > 40 ? r.project.slice(0, 37) + "..." : r.project;
  console.log(flag + " " + d + "  " + r.id + "  [" + proj2 + "]  " + r.title);
}
console.log("\nShown: " + Math.min(limit, rows.length) + " / Total: " + rows.length);
