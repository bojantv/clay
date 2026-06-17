#!/usr/bin/env node
var fs = require("fs");
var path = require("path");
var os = require("os");
var root = path.join(os.homedir(), ".clay", "sessions");
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
      var fd = fs.openSync(fp, "r");
      var buf = Buffer.alloc(4096);
      var n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      var meta = JSON.parse(buf.toString("utf8", 0, n).split("\n")[0]);
      if (meta.bookmarked || meta.favoriteOrder !== undefined) {
        var fo = meta.favoriteOrder === undefined || meta.favoriteOrder === null ? "-" : meta.favoriteOrder;
        console.log(
          "bm=" + (!!meta.bookmarked) + " fo=" + fo + "  " + meta.cliSessionId + "  " + (meta.title || "(untitled)")
        );
      }
    } catch (e) {}
  }
}
