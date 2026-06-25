// Regression test for the restart "port never released" bug.
//
// Node's server.close() stops accepting new connections but waits for open
// ones to end. A held-open keep-alive socket (e.g. an idle browser WebSocket
// or the codex mcp-bridge) therefore blocks close() indefinitely, so the port
// is never freed and the next daemon can't bind — leaving a process alive but
// serving nothing.
//
// The daemon's fix (lib/server.js destroySockets + lib/daemon.js shutdown
// paths) tracks every raw socket and destroys them on shutdown so close()
// returns at once. This test reproduces the exact mechanism: it proves a held
// connection blocks close(), and that force-destroying tracked sockets unblocks
// it. If the destroy step is ever removed, the "blocks close" phase of this
// test will hang/fail.

var test = require("node:test");
var assert = require("node:assert");
var http = require("http");
var net = require("net");

test("force-destroying tracked sockets lets server.close() return despite a held-open connection", function (t, done) {
  var server = http.createServer(function (req, res) {
    // Never end the response — mimic a long-lived connection.
    res.write("hi");
  });

  // Mirror lib/server.js socket tracking.
  var liveSockets = new Set();
  server.on("connection", function (socket) {
    liveSockets.add(socket);
    socket.on("close", function () { liveSockets.delete(socket); });
  });
  function destroySockets() {
    liveSockets.forEach(function (socket) {
      try { socket.destroy(); } catch (e) {}
    });
    liveSockets.clear();
  }

  server.listen(0, "127.0.0.1", function () {
    var port = server.address().port;
    var client = net.connect(port, "127.0.0.1", function () {
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");

      // Give the server a tick to accept + register the connection.
      setTimeout(function () {
        assert.strictEqual(liveSockets.size, 1, "connection should be tracked");

        var closed = false;
        server.close(function () { closed = true; });

        // close() must NOT have completed yet — the connection is held open.
        setTimeout(function () {
          assert.strictEqual(closed, false, "close() should still be waiting on the held connection");

          // The fix: force-destroy sockets. close() should now fire promptly.
          destroySockets();
          setTimeout(function () {
            assert.strictEqual(closed, true, "close() should complete after sockets are destroyed");
            try { client.destroy(); } catch (e) {}
            done();
          }, 100);
        }, 150);
      }, 100);
    });
    client.on("error", function () {}); // ignore reset from server.destroy
  });
});
