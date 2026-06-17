import { iconHtml, refreshIcons } from './icons.js';
import { getWs } from './ws-ref.js';
import { store } from './store.js';
import { meaningfulTextTitle } from './text-title.js';

var queuedItems = [];
var outsideClickBound = false;
// Whether queueing is disabled for the currently active session. This mirrors
// server-side per-session state (session.queueingDisabled), which is held in
// memory on the server so it survives a page refresh/reconnect but resets when
// the daemon restarts. Updated from session_switched / queued state payloads.
var currentSessionQueueingDisabled = false;

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
  if (!text && item.pastes && item.pastes.length > 0) return item.pastes.length === 1 ? "Pasted text" : item.pastes.length + " pasted texts";
  var title = meaningfulTextTitle(text, 180);
  if (title) return title;
  if (text.length > 180) return text.slice(0, 177) + "...";
  return text;
}

function imageSrc(image) {
  if (!image) return "";
  if (image.url) return image.url;
  if (image.data && image.mediaType) return "data:" + image.mediaType + ";base64," + image.data;
  return "";
}

function appendQueuedTooltip(row, item) {
  var hasText = !!(item.text && item.text.trim());
  var images = item.images || [];
  var pastes = item.pastes || [];
  if (!hasText && images.length === 0 && pastes.length === 0) return;

  var tooltip = document.createElement("div");
  tooltip.className = "queued-message-tooltip";
  tooltip.setAttribute("role", "tooltip");

  if (hasText) {
    var text = document.createElement("div");
    text.className = "queued-message-tooltip-text";
    text.textContent = item.text;
    tooltip.appendChild(text);
  }

  if (pastes.length > 0) {
    var pasteWrap = document.createElement("div");
    pasteWrap.className = "queued-message-tooltip-pastes";
    for (var p = 0; p < pastes.length; p++) {
      var paste = document.createElement("div");
      paste.className = "queued-message-tooltip-paste";
      var pasteLabel = document.createElement("div");
      pasteLabel.className = "queued-message-tooltip-label";
      pasteLabel.textContent = "Pasted text";
      var pasteText = document.createElement("div");
      pasteText.className = "queued-message-tooltip-text";
      pasteText.textContent = pastes[p] || "";
      paste.appendChild(pasteLabel);
      paste.appendChild(pasteText);
      pasteWrap.appendChild(paste);
    }
    tooltip.appendChild(pasteWrap);
  }

  if (images.length > 0) {
    var imgWrap = document.createElement("div");
    imgWrap.className = "queued-message-tooltip-images";
    for (var i = 0; i < images.length; i++) {
      var src = imageSrc(images[i]);
      if (!src) continue;
      var img = document.createElement("img");
      img.className = "queued-message-tooltip-img";
      img.src = src;
      img.alt = "Queued image";
      img.loading = "lazy";
      imgWrap.appendChild(img);
    }
    if (imgWrap.childNodes.length > 0) tooltip.appendChild(imgWrap);
  }

  if (tooltip.childNodes.length > 0) row.appendChild(tooltip);
}

function sendSteer(queueId) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !queueId) return;
  ws.send(JSON.stringify({ type: "steer_queued_message", queueId: queueId, sessionId: store.get("activeSessionId") || null }));
}

function sendClear(queueId) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !queueId) return;
  ws.send(JSON.stringify({ type: "clear_queued_message", queueId: queueId, sessionId: store.get("activeSessionId") || null }));
}

export function isQueueingDisabledForCurrentSession() {
  return currentSessionQueueingDisabled;
}

// Sync the active session's queueing-disabled flag from a server payload.
export function setQueueingDisabled(flag) {
  currentSessionQueueingDisabled = !!flag;
}

function turnOffQueueingForCurrentSession() {
  var sessionId = store.get("activeSessionId") || "";
  if (!sessionId) return;
  currentSessionQueueingDisabled = true; // optimistic; server confirms via state
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "set_session_queueing", sessionId: sessionId, disabled: true }));
  }
}

function editQueuedMessage(item) {
  if (!item || !item.queueId) return;
  sendClear(item.queueId);
  window.dispatchEvent(new CustomEvent("clay:restore-input-draft", {
    detail: {
      text: item.text || "",
      images: item.images || [],
      pastes: item.pastes || [],
      files: [],
    },
  }));
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
      row.tabIndex = 0;

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
      appendQueuedTooltip(row, item);
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
        images: msg.images || [],
        pastes: msg.pastes || [],
      };
      renderQueuedMessages();
      return;
    }
  }
  queuedItems.push({
    queueId: msg.queueId,
    text: msg.text || "",
    imageCount: msg.imageCount || 0,
    images: msg.images || [],
    pastes: msg.pastes || [],
  });
  renderQueuedMessages();
}

export function setQueuedUserMessages(items) {
  queuedItems = [];
  if (Array.isArray(items)) {
    for (var i = 0; i < items.length; i++) {
      var msg = items[i] || {};
      if (!msg.queueId) continue;
      queuedItems.push({
        queueId: msg.queueId,
        text: msg.text || "",
        imageCount: msg.imageCount || 0,
        images: msg.images || [],
        pastes: msg.pastes || [],
      });
    }
  }
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
