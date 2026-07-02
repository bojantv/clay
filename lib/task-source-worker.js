// Child process that runs the GitHub task-source scan off the daemon's event
// loop. The scan makes many synchronous `gh` CLI calls (for a dozen PRs it does
// ~3 calls each and blocks ~25s); running it in the daemon froze the whole event
// loop, so every connected client's heartbeat failed and the app appeared to
// "crash"/reconnect every 5 minutes when the auto-launch loop fired.
//
// The parsing logic is reused UNCHANGED from project-task-sources.js — this only
// moves the blocking work into a dedicated process whose loop has nothing else to
// serve. The parent forks this, sends {cwd, recipe, args} over IPC, and awaits
// the {ok, items} reply, so the daemon loop stays responsive throughout.
var taskSources = require("./project-task-sources");

process.on("message", function (input) {
  var result;
  try {
    var items = taskSources.fetchItems(input.cwd, input.recipe, input.args || {});
    result = { ok: true, items: items || [] };
  } catch (e) {
    result = { ok: false, error: (e && e.message) || String(e) };
  }
  try { process.send(result); } catch (sendErr) {}
  process.exit(0);
});

// Safety: if the parent never sends work (shouldn't happen), don't linger.
setTimeout(function () { process.exit(0); }, 130000).unref();
