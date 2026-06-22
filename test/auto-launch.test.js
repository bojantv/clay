var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachAutoLaunch } = require("../lib/project-auto-launch");

test("auto-launch maxPasses config overrides pr-review recipe default", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autolaunch-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: true,
      recipeId: "pr-review",
      recipes: ["pr-review"],
      maxPasses: 5,
      cron: "*/5 * * * *",
    },
  }, null, 2) + "\n");

  var recipe = {
    id: "pr-review",
    source: { provider: "github", kind: "pr-reviews", repo: "owner/repo" },
    launch: { defaultLimit: 5, maxPasses: 2 },
    session: { title: "PR #{number} {title}" },
    completion: {},
  };
  var launchedItem = null;
  var launcher = {
    loadRecipe: function () {
      return recipe;
    },
    startSessionForItem: function (ws, r, item) {
      launchedItem = Object.assign({}, item);
      return { localId: 42, title: "PR #10 Fix me" };
    },
  };
  var autoLaunch = attachAutoLaunch({
    cwd: cwd,
    sm: {
      sessions: new Map(),
      broadcastSessionList: function () {},
    },
    getTaskLauncher: function () {
      return launcher;
    },
    fetchItems: function () {
      return [{
        number: 10,
        title: "Fix me",
        url: "https://github.com/owner/repo/pull/10",
        key: "owner/repo#10",
        head_sha: "abc123",
        ci_failing: false,
        latestFeedbackTs: Date.now(),
      }];
    },
  });

  try {
    var result = autoLaunch.launchScheduled("pr-review");
    assert.strictEqual(result.started.length, 1);
    assert.ok(launchedItem, "PR item should launch");
    assert.strictEqual(launchedItem.max_passes, 5);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("disabled auto-launch config ignores stale registry triggers", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autolaunch-"));
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "config.json"), JSON.stringify({
    autoLaunch: {
      enabled: false,
      recipeId: "assigned-to-me",
      recipes: ["assigned-to-me", "pr-review"],
      cron: "*/5 * * * *",
    },
  }, null, 2) + "\n");

  var fetched = 0;
  var launched = 0;
  var updated = null;
  var autoLaunch = attachAutoLaunch({
    cwd: cwd,
    sm: {
      sessions: new Map(),
      broadcastSessionList: function () {},
    },
    loopRegistry: {
      getById: function () {
        return { id: "autolaunch_assigned", enabled: true, task: "assigned-to-me" };
      },
      updateRecord: function (id, data) {
        updated = { id: id, data: data };
      },
    },
    getTaskLauncher: function () {
      return {
        loadRecipe: function () {
          launched++;
          return null;
        },
      };
    },
    fetchItems: function () {
      fetched++;
      return [];
    },
  });

  try {
    autoLaunch.runScheduled({ id: "autolaunch_assigned", task: "assigned-to-me" });
    assert.strictEqual(fetched, 0);
    assert.strictEqual(launched, 0);
    assert.deepStrictEqual(updated, {
      id: "autolaunch_assigned",
      data: { enabled: false, nextRunAt: null },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
