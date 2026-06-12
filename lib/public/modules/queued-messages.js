import { iconHtml, refreshIcons } from './icons.js';
import { getWs } from './ws-ref.js';

var queuedItems = [];

function ensureQueuedBar() {
  var existing = document.getElementById("queued-message-bar");
  if (existing) return existing;
  var inputArea = document.getElementById("input-area");
  var inputWrapper = document.getElementById("input-wrapper");
  if (!inputArea || !inputWrapper) return null;
  var bar = document.createElement("div");
  bar.id = "queued-message-bar";
  bar.className = "hidden";
  inputArea.insertBefore(bar, inputWrapper);
  return bar;
}

function previewText(item) {
  var text = item.text || "";
  if (!text && item.imageCount > 0) return item.imageCount === 1 ? "Image" : item.imageCount + " images";
  if (text.length > 180) return text.slice(0, 177) + "...";
  return text;
}

function sendSteer(queueId) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !queueId) return;
  ws.send(JSON.stringify({ type: "steer_queued_message", queueId: queueId }));
}

function sendClear(queueId) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !queueId) return;
  ws.send(JSON.stringify({ type: "clear_queued_message", queueId: queueId }));
}

function renderQueuedMessages() {
  var bar = ensureQueuedBar();
  if (!bar) return;
  bar.innerHTML = "";
  if (queuedItems.length === 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  for (var i = 0; i < queuedItems.length; i++) {
    (function (item) {
      var row = document.createElement("div");
      row.className = "queued-message-item";

      var body = document.createElement("div");
      body.className = "queued-message-body";

      var title = document.createElement("div");
      title.className = "queued-message-title";
      title.textContent = "Queued for next turn";

      var preview = document.createElement("div");
      preview.className = "queued-message-preview";
      preview.textContent = previewText(item);

      body.appendChild(title);
      body.appendChild(preview);

      var steerBtn = document.createElement("button");
      steerBtn.type = "button";
      steerBtn.className = "queued-message-steer";
      steerBtn.title = "Send this queued message into the active response";
      steerBtn.innerHTML = iconHtml("zap") + "<span>Steer now</span>";
      steerBtn.addEventListener("click", function () {
        sendSteer(item.queueId);
      });

      var clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "queued-message-clear";
      clearBtn.title = "Clear queued message";
      clearBtn.innerHTML = iconHtml("x");
      clearBtn.addEventListener("click", function () {
        sendClear(item.queueId);
      });

      row.appendChild(body);
      row.appendChild(steerBtn);
      row.appendChild(clearBtn);
      bar.appendChild(row);
    })(queuedItems[i]);
  }
  refreshIcons();
}

export function handleQueuedUserMessage(msg) {
  if (!msg || !msg.queueId) return;
  for (var i = 0; i < queuedItems.length; i++) {
    if (queuedItems[i].queueId === msg.queueId) {
      queuedItems[i] = {
        queueId: msg.queueId,
        text: msg.text || "",
        imageCount: msg.imageCount || 0,
      };
      renderQueuedMessages();
      return;
    }
  }
  queuedItems.push({
    queueId: msg.queueId,
    text: msg.text || "",
    imageCount: msg.imageCount || 0,
  });
  renderQueuedMessages();
}

export function removeQueuedUserMessage(queueId) {
  if (!queueId) return;
  queuedItems = queuedItems.filter(function (item) {
    return item.queueId !== queueId;
  });
  renderQueuedMessages();
}

export function clearQueuedUserMessages() {
  queuedItems = [];
  renderQueuedMessages();
}
