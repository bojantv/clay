import { iconHtml, refreshIcons } from './icons.js';
import { getWs } from './ws-ref.js';
import { store } from './store.js';
import { meaningfulTextTitle } from './text-title.js';

var queuedItems = [];
var outsideClickBound = false;
var queueingDisabledBySession = {};

function bindOutsideClick() {
  if (outsideClickBound) return;
  outsideClickBound = true;
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest(".queued-message-more-wrap")) return;
    closeQueuedMenus();
  });
}

function ensureQueuedBar() {
  bindOutsideClick();
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
  var title = meaningfulTextTitle(text, 180);
  if (title) return title;
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

export function isQueueingDisabledForCurrentSession() {
  var sessionId = store.get("activeSessionId") || "";
  return !!(sessionId && queueingDisabledBySession[sessionId]);
}

function turnOffQueueingForCurrentSession() {
  var sessionId = store.get("activeSessionId") || "";
  if (!sessionId) return;
  queueingDisabledBySession[sessionId] = true;
}

function editQueuedMessage(item) {
  if (!item || !item.queueId) return;
  sendClear(item.queueId);
  var input = document.getElementById("input");
  if (!input) return;
  input.value = item.text || "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  try {
    input.selectionStart = input.selectionEnd = input.value.length;
  } catch (e) {}
}

function closeQueuedMenus() {
  var menus = document.querySelectorAll(".queued-message-menu");
  for (var i = 0; i < menus.length; i++) menus[i].remove();
}

function toggleMenu(item, anchor) {
  var existing = anchor.parentNode ? anchor.parentNode.querySelector(".queued-message-menu") : null;
  closeQueuedMenus();
  if (existing) return;
  var menu = document.createElement("div");
  menu.className = "queued-message-menu";

  var editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "queued-message-menu-item";
  editBtn.innerHTML = iconHtml("pencil") + "<span>Edit message</span>";
  editBtn.addEventListener("click", function () {
    closeQueuedMenus();
    editQueuedMessage(item);
  });

  var queueingBtn = document.createElement("button");
  queueingBtn.type = "button";
  queueingBtn.className = "queued-message-menu-item";
  queueingBtn.innerHTML = iconHtml("corner-down-right") + "<span>Turn off queueing</span>";
  queueingBtn.addEventListener("click", function () {
    closeQueuedMenus();
    turnOffQueueingForCurrentSession();
  });

  menu.appendChild(editBtn);
  menu.appendChild(queueingBtn);
  anchor.parentNode.appendChild(menu);
  refreshIcons();
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
      steerBtn.innerHTML = iconHtml("corner-down-right") + "<span>Steer</span>";
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

      var moreWrap = document.createElement("div");
      moreWrap.className = "queued-message-more-wrap";
      var moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "queued-message-more";
      moreBtn.title = "More queued message actions";
      moreBtn.innerHTML = iconHtml("ellipsis");
      moreBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleMenu(item, moreBtn);
      });
      moreWrap.appendChild(moreBtn);

      row.appendChild(body);
      row.appendChild(steerBtn);
      row.appendChild(clearBtn);
      row.appendChild(moreWrap);
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
