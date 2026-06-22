var test = require("node:test");
var assert = require("node:assert");

var helpers = require("../lib/yoke/adapters/github-copilot-helpers");

test("Copilot prompt blocks omit images unless the agent advertises image support", function () {
  var images = [{ mediaType: "image/png", data: "abc123" }];
  var blocks = helpers.copilotPromptBlocks("runtime", "look at this", images, false);

  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, "text");
  assert.match(blocks[0].text, /does not advertise image prompt support/);
});

test("Copilot prompt blocks include ACP images when supported", function () {
  var images = [{ mediaType: "image/png", data: "abc123" }];
  var blocks = helpers.copilotPromptBlocks("runtime", "look at this", images, true);

  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(blocks[1], {
    type: "image",
    data: "abc123",
    mimeType: "image/png",
  });
});

test("Copilot image support follows ACP agent prompt capabilities", function () {
  assert.strictEqual(helpers.copilotSupportsPromptImages({ promptCapabilities: { image: true } }), true);
  assert.strictEqual(helpers.copilotSupportsPromptImages({ promptCapabilities: { image: false } }), false);
  assert.strictEqual(helpers.copilotSupportsPromptImages({}), false);
});
