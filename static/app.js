const state = {
  peerIp: "",
  tcpPort: 9009,
  localAppPort: 5000,
  localTcpPort: 9009,
  appProtocol: window.location.protocol.replace(":", "") || "https",
  outbox: [],
  selected: new Set(),
  selectedInbox: new Set(),
  transferId: null,
  transferStartTime: null,
  transferTotalSize: 0,
  currentOperation: null,
  uploadXhr: null,
  monitoringTransferId: null,
  monitorInterval: null,
  receiveMonitorInterval: null,
  transferCompleted: false,
  receiveTransfers: [],
  lastProgressPercent: 0,
  cancelRequested: false,
};

const byId = (id) => document.getElementById(id);

class Toast {
  static create(message, type = "info", duration = 3000) {
    const container = byId("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const trimmedMessage = message.trim();
    const leadingIcons = ["✅", "❌", "ℹ️", "⚠️", "📁", "📤", "📥", "📋"];
    const leadingIcon = leadingIcons.find((icon) =>
      trimmedMessage.startsWith(icon),
    );

    const normalizeIcon = (icon) => icon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const normalizedMessage = leadingIcon
      ? trimmedMessage.replace(
          new RegExp("^(" + normalizeIcon(leadingIcon) + ")+\\s*"),
          leadingIcon + " ",
        )
      : trimmedMessage;

    const showIcon = !leadingIcon;
    let icon = "";
    if (showIcon) {
      icon = "💬";
      if (type === "success") icon = "✅";
      else if (type === "error") icon = "❌";
      else if (type === "info") icon = "ℹ️";
    }

    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-message">${normalizedMessage}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.classList.add("removing");
        setTimeout(() => toast.remove(), 400);
      }
    }, duration);
  }

  static success(message, duration) {
    Toast.create(message, "success", duration);
  }

  static error(message, duration) {
    Toast.create(message, "error", duration);
  }

  static info(message, duration) {
    Toast.create(message, "info", duration);
  }
}

function addButtonClickAnimation(btn) {
  btn.addEventListener("click", function (e) {
    const ripple = document.createElement("span");
    ripple.style.position = "absolute";
    ripple.style.pointerEvents = "none";
    this.style.position = "relative";
    this.style.overflow = "hidden";
  });
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const DOWNLOADS_SAVED_MESSAGE = "The File Saved In Your Downloads";
const DOWNLOADS_SAVED_MULTI_MESSAGE = "The Files Saved In Your Downloads";

async function saveInboxFileToDownloads(filename) {
  const response = await fetch(`/download/${encodeURIComponent(filename)}`);
  if (!response.ok) {
    throw new Error(`Failed to save ${filename}`);
  }

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function normalizePercent(value) {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(Math.max(pct, 0), 100);
}

// Remove direct status text update, use toast instead
function setStatus(text) {
  Toast.info(text, 2000);
}

function setButtonLoading(btn, isLoading) {
  if (isLoading) {
    btn.classList.add("loading");
    btn.disabled = true;
  } else {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

// Remove spinner logic
function showTransferSpinner() {}
function hideTransferSpinner() {}

// Show only the red moving bar/circle for progress
function showTransferProgress() {
  const movableCircle = byId("movableCircle");
  if (movableCircle) {
    movableCircle.classList.remove("hidden");
    movableCircle.style.background = "linear-gradient(45deg, #ff4444, #ff6666)";
    movableCircle.style.animationPlayState = "running";
  }
}

function hideTransferProgress() {
  const movableCircle = byId("movableCircle");
  if (movableCircle) {
    movableCircle.classList.add("hidden");
    movableCircle.style.animationPlayState = "paused";
  }
}

function updateMovableCircleColor(progress) {
  const movableCircle = byId("movableCircle");
  if (!movableCircle) return;
  // Always red for upload, stop animation if 100% or canceled
  const pct = normalizePercent(progress);
  if (pct >= 100 || state.cancelRequested) {
    movableCircle.style.animationPlayState = "paused";
  } else {
    movableCircle.style.animationPlayState = "running";
  }
}

function showMovableCircle() {
  const movableCircle = byId("movableCircle");
  if (movableCircle) movableCircle.classList.remove("hidden");
}

function hideMovableCircle() {
  const movableCircle = byId("movableCircle");
  if (movableCircle) movableCircle.classList.add("hidden");
}

function setTransferProgressText(text) {
  const el = byId("transferProgressText");
  if (el) {
    el.textContent = text;
  }
}

function setCurrentFileDetails(name, size) {
  const nameEl = byId("currentFileName");
  const sizeEl = byId("currentFileSize");
  if (nameEl) nameEl.textContent = name || "--";
  if (sizeEl) sizeEl.textContent = size || "--";
}

function updateConnectionStatus(isConnected, peerIp = null) {
  const badge = byId("connectionStatus");
  const connectBtn = byId("connectPeer");
  if (isConnected) {
    if (badge) {
      badge.classList.add("connected");
      badge.textContent = `✓ Connected to ${peerIp}`;
    }
    const statusIndicator = document.querySelector(".status-indicator");
    if (statusIndicator) {
      statusIndicator.classList.add("active");
      statusIndicator.classList.remove("idle");
    }
  } else {
    if (badge) {
      badge.classList.remove("connected");
      badge.textContent = "Disconnected";
    }
    const statusIndicator = document.querySelector(".status-indicator");
    if (statusIndicator) {
      statusIndicator.classList.remove("active");
      statusIndicator.classList.add("idle");
    }
  }
}

// Function to update running status to light red
function updateRunningStatus(isRunning) {
  const badge = byId("transferBadge");
  if (isRunning) {
    badge.style.backgroundColor = "#ffcccc"; // Light red color
    badge.style.color = "#cc0000"; // Darker red text
  } else {
    badge.style.backgroundColor = ""; // Reset to default
    badge.style.color = ""; // Reset to default
  }
}

function updateFileCountBadge() {
  const badge = byId("fileCountBadge");
  if (badge) badge.textContent = state.outbox.length;
}

function updateInboxCountBadge(count) {
  const badge = byId("inboxCountBadge");
  if (badge) badge.textContent = count;
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function renderOutbox() {
  const list = byId("outboxList");
  list.innerHTML = "";
  if (state.outbox.length === 0) {
    list.innerHTML = '<p class="empty-message">No files in outbox</p>';
  }
  state.outbox.forEach((file) => {
    const li = document.createElement("li");

    const fileInfo = document.createElement("div");
    fileInfo.className = "file-info";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selected.has(file.file_id);
    cb.disabled = file.status === "uploading";
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(file.file_id);
      else state.selected.delete(file.file_id);
    });

    const label = document.createElement("span");
    label.textContent = `${file.name} (${fmtBytes(file.size)})`;

    fileInfo.appendChild(cb);
    fileInfo.appendChild(label);

    if (file.status === "uploading") {
      const statusPill = document.createElement("span");
      statusPill.className = "file-status-pill";
      statusPill.textContent = "Uploading...";
      fileInfo.appendChild(statusPill);
    }

    // Add click handler to entire list item for selection
    li.addEventListener("click", (e) => {
      // Only toggle selection if not clicking on checkbox
      if (e.target.type !== "checkbox") {
        cb.checked = !cb.checked;
        if (cb.checked) state.selected.add(file.file_id);
        else state.selected.delete(file.file_id);
      }
    });

    li.appendChild(fileInfo);
    list.appendChild(li);
  });
  updateFileCountBadge();
  const selectAllBtn = byId("selectAllOutbox");
  if (selectAllBtn) {
    selectAllBtn.textContent =
      state.outbox.length && state.selected.size === state.outbox.length
        ? "Clear Selection"
        : "Select All";
  }
}

function renderInbox(files) {
  const list = byId("inboxList");
  const emptyMsg = byId("emptyInboxMessage");
  list.innerHTML = "";

  if (files.length === 0) {
    emptyMsg.style.display = "block";
  } else {
    emptyMsg.style.display = "none";
  }

  files.forEach((file) => {
    const li = document.createElement("li");

    const fileInfo = document.createElement("div");
    fileInfo.className = "file-info";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selectedInbox.has(file.name);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedInbox.add(file.name);
      else state.selectedInbox.delete(file.name);
      const selectAllBtn = byId("selectAllInbox");
      if (selectAllBtn) {
        selectAllBtn.textContent =
          state.selectedInbox.size === state.inboxFiles.length
            ? "Clear Selection"
            : "Select All";
      }
    });

    const link = document.createElement("a");
    link.href = "#";
    link.textContent = `${file.name} (${fmtBytes(file.size)})`;
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await saveInboxFileToDownloads(file.name);
        Toast.success(DOWNLOADS_SAVED_MESSAGE);
      } catch (err) {
        Toast.error(`Failed to save file: ${err.message}`);
      }
    });
    
    // Force correct colors with inline styles
    const isDarkMode = document.body.classList.contains('dark-mode');
    if (isDarkMode) {
      link.style.color = '#ffffff';
      link.style.fontWeight = '500';
      link.style.textDecoration = 'none';
      link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
      link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
    } else {
      link.style.color = '#000000';
      link.style.fontWeight = '500';
      link.style.textDecoration = 'none';
      link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
      link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
    }

    fileInfo.appendChild(cb);
    fileInfo.appendChild(link);

    // Add click handler to entire list item for selection
    li.addEventListener("click", (e) => {
      // Only toggle selection if not clicking on checkbox
      if (e.target.type !== "checkbox") {
        cb.checked = !cb.checked;
        if (cb.checked) state.selectedInbox.add(file.name);
        else state.selectedInbox.delete(file.name);
        const selectAllBtn = byId("selectAllInbox");
        if (selectAllBtn) {
          selectAllBtn.textContent =
            state.selectedInbox.size === state.inboxFiles.length
              ? "Clear Selection"
              : "Select All";
        }
      }
    });

    li.appendChild(fileInfo);
    list.appendChild(li);
  });

  const selectAllBtn = byId("selectAllInbox");
  if (selectAllBtn) {
    selectAllBtn.textContent =
      files.length > 0 && state.selectedInbox.size === files.length
        ? "Clear Selection"
        : "Select All";
  }

  updateInboxCountBadge(files.length);
}

async function refreshOutbox() {
  const data = await fetchJSON("/api/outbox");
  state.outbox = data.files || [];
  renderOutbox();
}

async function refreshInbox() {
  const data = await fetchJSON("/api/inbox");
  const files = data.files || [];

  const namesInInbox = new Set(files.map((file) => file.name));
  state.selectedInbox.forEach((name) => {
    if (!namesInInbox.has(name)) {
      state.selectedInbox.delete(name);
    }
  });

  state.inboxFiles = files;
  state.inboxLength = files.length;
  renderInbox(state.inboxFiles);
}

function startInboxAutoRefresh() {
  if (state.inboxRefreshInterval) {
    clearInterval(state.inboxRefreshInterval);
  }

  state.inboxRefreshInterval = setInterval(async () => {
    try {
      await refreshInbox();
    } catch (err) {
      console.warn("Inbox auto-refresh failed:", err);
    }
  }, 3000);
}

async function removeOutboxFile(fileId) {
  if (!confirm("Remove this file from outbox?")) return;
  try {
    await fetchJSON(`/api/outbox/${fileId}`, { method: "DELETE" });
    Toast.success("❌ File Removed");
    setStatus("File removed from outbox.");
    await refreshOutbox();
  } catch (err) {
    Toast.error(`Failed to remove file: ${err.message}`);
    setStatus(`Failed to remove file: ${err.message}`);
  }
}

async function removeInboxFile(filename) {
  if (!confirm("Remove this file from inbox?")) return;
  try {
    await fetchJSON(`/api/inbox/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    state.selectedInbox.delete(filename);
    Toast.success("❌ File Removed");
    setStatus("File removed from inbox.");
    await refreshInbox();
  } catch (err) {
    Toast.error(`Failed to remove file: ${err.message}`);
    setStatus(`Failed to remove file: ${err.message}`);
  }
}

async function deleteSelectedOutbox() {
  const fileIds = [...state.selected];
  if (!fileIds.length) {
    Toast.error("Select at least one outbox file to delete.");
    return;
  }
  if (!confirm("Delete selected outbox files?")) return;

  try {
    await Promise.all(
      fileIds.map((fileId) =>
        fetchJSON(`/api/outbox/${fileId}`, { method: "DELETE" }),
      ),
    );
    state.selected.clear();
    Toast.success("✅ Selected outbox files deleted");
    setStatus("Selected outbox files deleted.");
    await refreshOutbox();
  } catch (err) {
    Toast.error(`Failed to delete selected outbox files: ${err.message}`);
    setStatus(`Failed to delete selected outbox files: ${err.message}`);
  }
}

async function deleteAllOutbox() {
  if (!state.outbox.length) {
    Toast.error("No files in outbox to delete.");
    return;
  }
  if (!confirm("Delete all outbox files?")) return;

  try {
    await Promise.all(
      state.outbox.map((file) =>
        fetchJSON(`/api/outbox/${file.file_id}`, { method: "DELETE" }),
      ),
    );
    state.selected.clear();
    Toast.success("✅ All outbox files deleted");
    // Don't set redundant status message
    // setStatus("All outbox files deleted.");
    await refreshOutbox();
  } catch (err) {
    Toast.error(`Failed to delete all outbox files: ${err.message}`);
    setStatus(`Failed to delete all outbox files: ${err.message}`);
  }
}

function toggleSelectAllOutbox() {
  if (state.selected.size < state.outbox.length) {
    state.outbox.forEach((file) => state.selected.add(file.file_id));
    const selectAllBtn = byId("selectAllOutbox");
    if (selectAllBtn) selectAllBtn.textContent = "Clear Selection";
  } else {
    state.selected.clear();
    const selectAllBtn = byId("selectAllOutbox");
    if (selectAllBtn) selectAllBtn.textContent = "Select All";
  }
  renderOutbox();
}

async function cancelCurrentTransfer() {
  // Clear all state regardless of operation type
  const wasReceiving = state.currentOperation === "receive";
  const wasSending = state.currentOperation === "send";
  const wasUploading = state.currentOperation === "upload";
  
  if (wasUploading && state.uploadXhr) {
    const confirmation = confirm("Cancel the current upload?");
    if (!confirmation) return;
    state.cancelRequested = true;
    state.uploadXhr.abort();
    clearUploadingPlaceholders();
  } else if (state.transferId || wasReceiving) {
    const confirmation = confirm("Cancel the current transfer?");
    if (!confirmation) return;
  }

  // Completely clear all state and stop all processes
  state.cancelRequested = true;
  state.currentOperation = null;
  state.uploadXhr = null;
  state.transferId = null;
  state.cancelRequested = false;
  
  // Clear all intervals
  if (state.monitorInterval) {
    clearInterval(state.monitorInterval);
    state.monitorInterval = null;
  }
  if (state.receiveMonitorInterval) {
    clearInterval(state.receiveMonitorInterval);
    state.receiveMonitorInterval = null;
  }
  
  // Hide all UI elements
  hideTransferSpinner();
  hideTransferProgress();
  hideMovableCircle();
  updateRunningStatus(false);
  
  // Reset UI to idle state
  const cancelBtn = byId("cancelTransfer");
  if (cancelBtn) cancelBtn.disabled = true;
  const transferBadge = byId("transferBadge");
  if (transferBadge) {
    transferBadge.textContent = "Idle";
    transferBadge.className = "status-badge status-idle";
  }
  const transferEta = byId("transferEta");
  if (transferEta) transferEta.textContent = "ETA: --";
  const stats = byId("stats");
  if (stats) stats.innerHTML = `Status: <span class="status-value">idle</span>`;
  setTransferProgressText("Operation cancelled");
  
  // Stop cursor animation
  const statusIndicator = document.querySelector(".status-indicator");
  if (statusIndicator) {
    statusIndicator.classList.remove("active");
    statusIndicator.classList.add("idle");
  }
  
  // Show single appropriate message
  if (wasUploading) {
    Toast.info("⚠️ Upload cancelled");
  } else if (wasSending) {
    Toast.info("⚠️ Send cancelled");
  } else if (wasReceiving) {
    Toast.info("⚠️ Receive cancelled");
  } else {
    Toast.info("⚠️ Operation cancelled");
  }
  
  // Restart receiving monitor to handle new transfers
  setTimeout(() => {
    monitorReceivingFiles();
  }, 1000);
}

async function deleteSelectedInbox() {
  const files = [...state.selectedInbox];
  if (!files.length) {
    Toast.error("Select at least one inbox file to delete.");
    return;
  }
  if (!confirm("Delete selected inbox files?")) return;

  try {
    await Promise.all(
      files.map((filename) =>
        fetchJSON(`/api/inbox/${encodeURIComponent(filename)}`, {
          method: "DELETE",
        }),
      ),
    );
    state.selectedInbox.clear();
    Toast.success("✅ Selected inbox files deleted");
    setStatus("Selected inbox files deleted.");
    await refreshInbox();
  } catch (err) {
    Toast.error(`Failed to delete selected inbox files: ${err.message}`);
    setStatus(`Failed to delete selected inbox files: ${err.message}`);
  }
}

async function deleteAllInbox() {
  const data = await fetchJSON("/api/inbox");
  const files = data.files || [];
  if (!files.length) {
    Toast.error("No files in inbox to delete.");
    return;
  }
  if (!confirm("Delete all inbox files?")) return;

  try {
    await Promise.all(
      files.map((file) =>
        fetchJSON(`/api/inbox/${encodeURIComponent(file.name)}`, {
          method: "DELETE",
        }),
      ),
    );
    state.selectedInbox.clear();
    Toast.success("✅ All inbox files deleted");
    // Don't set redundant status message
    // setStatus("All inbox files deleted.");
    await refreshInbox();
  } catch (err) {
    Toast.error(`Failed to delete all inbox files: ${err.message}`);
    setStatus(`Failed to delete all inbox files: ${err.message}`);
  }
}

function toggleSelectAllInbox() {
  if (state.selectedInbox.size < state.inboxLength) {
    state.inboxFiles.forEach((file) => state.selectedInbox.add(file.name));
    const selectAllBtn = byId("selectAllInbox");
    if (selectAllBtn) selectAllBtn.textContent = "Clear Selection";
  } else {
    state.selectedInbox.clear();
    const selectAllBtn = byId("selectAllInbox");
    if (selectAllBtn) selectAllBtn.textContent = "Select All";
  }
  renderInbox(state.inboxFiles);
}

async function downloadSelectedInbox() {
  const files = [...state.selectedInbox];
  if (!files.length) {
    Toast.error("Select at least one file to download.");
    return;
  }

  try {
    for (let i = 0; i < files.length; i += 1) {
      await saveInboxFileToDownloads(files[i]);
      if (i < files.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    Toast.success(
      files.length === 1
        ? DOWNLOADS_SAVED_MESSAGE
        : DOWNLOADS_SAVED_MULTI_MESSAGE,
    );
  } catch (err) {
    Toast.error(`Failed to save files: ${err.message}`);
  }
}

async function uploadSelected(files) {
  if (!files.length) return;

  // Remove blocking checks - allow simultaneous operations
  // if (state.currentOperation === "send") {
  //   Toast.error("⚠️ A send is already in progress. Please stop it before uploading new files.");
  //   return;
  // }
  // if (state.currentOperation === "receive") {
  //   Toast.error("⚠️ A receive operation is active. Please wait until it finishes before uploading.");
  //   return;
  // }
  
  // Start circle animation for upload
  const statusIndicator = document.querySelector(".status-indicator");
  if (statusIndicator) {
    statusIndicator.classList.remove("idle");
    statusIndicator.classList.add("active");
  }

  const fileArray = Array.from(files);
  const pendingItems = fileArray.map((file, index) => ({
    file_id: `pending-${Date.now()}-${index}`,
    name: file.name,
    size: file.size,
    status: "uploading",
  }));

  state.outbox.push(...pendingItems);
  renderOutbox();
  state.currentOperation = "upload";
  state.uploadXhr = null;
  state.lastProgressPercent = 0;
  state.transferTotalSize = fileArray.reduce((sum, f) => sum + f.size, 0);
  state.transferStartTime = Date.now();
  state.transferDetailsVisible = true;
  const transferDetails = byId("transferDetails");
  if (transferDetails) transferDetails.style.display = "block";
  const totalFileSize = byId("totalFileSize");
  if (totalFileSize) totalFileSize.textContent = fmtBytes(state.transferTotalSize);
  const filesCompleted = byId("filesCompleted");
  if (filesCompleted) filesCompleted.textContent = fileArray.length;
  setCurrentFileDetails("--", "--");
  const transferBadge = byId("transferBadge");
  if (transferBadge) {
    transferBadge.textContent = "Uploading";
    transferBadge.className = "status-badge status-sending";
  }
  updateRunningStatus(true); // Set light red color for running status
  const cancelBtn = byId("cancelTransfer");
  if (cancelBtn) cancelBtn.disabled = false;
  showTransferSpinner();
  showTransferProgress(); // This now shows movable circle instead of bar
  // Don't set redundant status message
  // setStatus(`Uploading ${fileArray.length} file(s)...`);
  Toast.info(`📁 Uploading ${fileArray.length} file(s) to outbox...`);

  for (let index = 0; index < fileArray.length; index += 1) {
    const file = fileArray[index];
    const placeholderId = pendingItems[index].file_id;
    const isLastFile = index === fileArray.length - 1;

    try {
      await uploadSingleFile(file, placeholderId, index + 1, fileArray.length);
      state.outbox = state.outbox.filter((item) => item.file_id !== placeholderId);
      await refreshOutbox();
      if (!isLastFile) {
        state.lastProgressPercent = 0;
      }
    } catch (err) {
      clearUploadingPlaceholders();
      state.currentOperation = null;
      state.uploadXhr = null;
      hideTransferSpinner();
      setTransferProgressText(`Upload cancelled`);
      byId("cancelTransfer").disabled = true;
      // Don't show error message for cancelled uploads to avoid duplicates
      if (!err.message.includes('cancelled')) {
        Toast.error(`Upload failed: ${err.message}`);
      }
      // Don't set redundant status message
      // setStatus(`Upload failed: ${err.message}`);
      return;
    }
  }

  state.currentOperation = null;
  state.uploadXhr = null;
  hideTransferSpinner();
  hideTransferProgress(); // Hide progress bar
  showMovableCircle(); // Show movable circle instead
  updateRunningStatus(false); // Reset light red color
  
  // Only show completion message if files were actually uploaded
  if (fileArray.length > 0) {
    const totalTime = Math.round((Date.now() - state.transferStartTime) / 1000);
    const minutes = Math.floor(totalTime / 60);
    const seconds = totalTime % 60;
    const timeString = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    
    // Only show time if it's greater than 0
    if (totalTime > 0) {
      const timeTaken = byId("timeTaken");
      if (timeTaken) timeTaken.textContent = timeString;
      setTransferProgressText(`Upload complete - ${fileArray.length} file(s) uploaded`);
      const cancelBtn = byId("cancelTransfer");
      if (cancelBtn) cancelBtn.disabled = true;
    }  
    const fileInput = byId("fileInput");
    if (fileInput) fileInput.value = "";
  }
}

async function uploadSingleFile(file, placeholderId, fileIndex, totalFiles) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("files", file);

    let uploadedSize = 0;
    const totalSize = file.size;
    let lastUploadPct = 0;
    const startTime = Date.now();
    let countdownInterval = null;

    const xhr = new XMLHttpRequest();
    state.uploadXhr = xhr;

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || totalSize === 0) {
        const progressPercent = byId("progressPercent");
        if (progressPercent) progressPercent.textContent = "0%";
        const bar = byId("bar");
        if (bar) bar.style.width = "0%";
        return;
      }

      uploadedSize = event.loaded;
      let pct = normalizePercent((uploadedSize / totalSize) * 100);
      pct = Math.max(pct, lastUploadPct);
      lastUploadPct = pct;

      const elapsed = Math.max((Date.now() - startTime) / 1000, 0.001);
      const speed = uploadedSize / elapsed;
      const remainingBytes = Math.max(totalSize - uploadedSize, 0);
      const timeRemaining = speed > 0 ? Math.ceil(remainingBytes / speed) : null;
      const elapsedText = `${Math.floor(elapsed)}s`;
      const speedText = `${(speed / (1024 * 1024)).toFixed(2)} MB/s`;

      // Update movable circle color instead of bar
      updateMovableCircleColor(pct);
      // Remove bar and percentage updates
      // byId("bar").style.width = `${pct.toFixed(1)}%`;
      // byId("progressPercent").textContent = `${pct.toFixed(1)}%`;
      // setProgressBubblePosition(pct);
      byId("stats").innerHTML =
        `Status: <span class="status-value">Uploading</span> | ${fmtBytes(uploadedSize)} of ${fmtBytes(totalSize)} | ${speedText} | ${elapsedText}`;
      const transferEta = byId("transferEta");
      if (transferEta) transferEta.textContent = "--";
      setCurrentFileDetails(`${file.name} (${fileIndex}/${totalFiles})`, fmtBytes(totalSize));
      showTransferProgress(); // This now updates movable circle
      setTransferProgressText(`Uploading ${file.name} — ${fmtBytes(totalSize)}`);
      // Don't set status for each file to avoid multiple messages
      // setStatus(`Uploading ${file.name} (${fileIndex}/${totalFiles})`);
    });

    xhr.addEventListener("load", async () => {
      clearInterval(countdownInterval);
      state.uploadXhr = null;
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.ok) {
            Toast.success(`✅ Uploaded ${file.name}`);
            resolve();
          } else {
            reject(new Error(data.error || "Upload failed"));
          }
        } catch (err) {
          reject(err);
        }
      } else {
        try {
          const data = JSON.parse(xhr.responseText);
          reject(new Error(data.error || `Upload failed: HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`Upload failed: HTTP ${xhr.status}: ${xhr.statusText}`));
        }
      }
    });

    xhr.addEventListener("error", () => {
      clearInterval(countdownInterval);
      state.uploadXhr = null;
      reject(new Error("Network error during upload"));
    });

    xhr.addEventListener("abort", () => {
      clearInterval(countdownInterval);
      state.uploadXhr = null;
      reject(new Error("Upload cancelled by user"));
    });

    xhr.open("POST", "/api/upload");
    xhr.send(form);

    countdownInterval = setInterval(() => {
      const elapsed = Math.max((Date.now() - startTime) / 1000, 1);
      const speed = Math.min(uploadedSize / elapsed, totalSize);
      const remainingBytes = Math.max(totalSize - uploadedSize, 0);
      const timeRemaining = speed > 0 ? Math.ceil(remainingBytes / speed) : null;
      const transferEta = byId("transferEta");
      if (transferEta) transferEta.textContent = "--";
    }, 1000);
  });
}

function clearUploadingPlaceholders() {
  state.outbox = state.outbox.filter((item) => item.status !== "uploading");
  renderOutbox();
}

async function connectPeer() {
  console.log("connectPeer function called");
  const peerIp = byId("peerIp").value.trim();
  console.log("Peer IP entered:", peerIp);

  if (!peerIp) {
    console.log("No peer IP provided");
    Toast.error("Please enter receiver IP");
    setStatus("Enter receiver IP first.");
    return;
  }

  const connectBtn = byId("connectPeer");
  setButtonLoading(connectBtn, true);
  Toast.info("🔗 Connecting to peer...");

  try {
    const data = await fetchJSON("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_ip: peerIp,
        app_port: state.localAppPort,
        tcp_port: state.localTcpPort,
      }),
    });
    state.peerIp = data.peer_ip;
    state.tcpPort = state.localTcpPort;

    Toast.success(`✅ Connected Successfully to Peer (${state.peerIp})`);
    updateConnectionStatus(true, state.peerIp);
  } catch (err) {
    Toast.error(`Connection failed: ${err.message}`);
    setStatus(`Connection failed: ${err.message}`);
    updateConnectionStatus(false);
  } finally {
    setButtonLoading(connectBtn, false);
  }
}

async function sendFiles() {
  // Remove blocking checks - allow simultaneous operations
  // if (state.currentOperation === "upload") {
  //   alert("A file upload is running. Stop it before sending files.");
  //   Toast.error("Stop the current upload before sending.");
  //   return;
  // }
  // if (state.currentOperation === "receive") {
  //   alert("A receive operation is active. Wait until it finishes before sending files.");
  //   Toast.error("Wait for the current receive operation to finish.");
  //   return;
  // }
  if (!state.peerIp) {
    Toast.info("ℹ️ Connect to a peer first.");
    // Don't set redundant status message
    // setStatus("Connect to a peer first.");
    return;
  }
  const file_ids = [...state.selected];
  if (!file_ids.length) {
    Toast.info("ℹ️ Select at least one file to send");
    // Don't set redundant status message
    // setStatus("Select at least one file to send.");
    return;
  }
  
  // Double check that files are still selected before sending
  const selectedFiles = state.outbox.filter(f => file_ids.includes(f.file_id));
  if (selectedFiles.length !== file_ids.length) {
    // Try to refresh outbox and check again
    try {
      await refreshOutbox();
      const refreshedFiles = state.outbox.filter(f => file_ids.includes(f.file_id));
      if (refreshedFiles.length === file_ids.length) {
        // Files are now available, proceed with send
        state.transferTotalSize = refreshedFiles.reduce((sum, f) => sum + f.size, 0);
      } else {
        Toast.info("⚠️ Selected files are not available. Please try again.");
        // Don't set redundant status message
        // setStatus("Some selected files are no longer available.");
        return;
      }
    } catch (err) {
      Toast.info("⚠️ Selected files are not available. Please try again.");
      return;
    }
  } else {
    state.transferTotalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  }

  const sendBtn = byId("sendFiles");
  setButtonLoading(sendBtn, true);
  Toast.info(`📤 Sending ${file_ids.length} file(s)...`);
  
  // Start circle animation for send
  const statusIndicator = document.querySelector(".status-indicator");
  if (statusIndicator) {
    statusIndicator.classList.remove("idle");
    statusIndicator.classList.add("active");
  }

  try {
    const data = await fetchJSON("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_ip: state.peerIp,
        tcp_port: state.tcpPort,
        file_ids,
      }),
    });
    state.transferId = data.transfer_id;
    state.currentOperation = "send";
    state.transferStartTime = Date.now();

    const totalFileSize = byId("totalFileSize");
    if (totalFileSize) totalFileSize.textContent = fmtBytes(state.transferTotalSize);
    const timeTaken = byId("timeTaken");
    if (timeTaken) timeTaken.textContent = "--";
    const filesCompleted = byId("filesCompleted");
    if (filesCompleted) filesCompleted.textContent = file_ids.length;
    setCurrentFileDetails(
      `${file_ids.length} file(s)`,
      fmtBytes(state.transferTotalSize),
    );
    setTransferProgressText(`Sending ${file_ids.length} file(s) — ${fmtBytes(state.transferTotalSize)}`);
    showTransferSpinner();
    showTransferProgress(); // This now shows movable circle instead of bar
    updateRunningStatus(true); // Set light red color for running status

    Toast.info("📤 Transfer started");
    // Don't set redundant status message
    // setStatus(
    //   `Transfer started: Sending ${fmtBytes(state.transferTotalSize)}...`,
    // );
    state.selected.clear();
    renderOutbox();
    monitorTransfer();
  } catch (err) {
    Toast.error(`Send failed: ${err.message}`);
    setStatus(`Send failed: ${err.message}`);
  } finally {
    setButtonLoading(sendBtn, false);
  }
}

function setProgressBubblePosition(pct) {
  const progressText = byId("progressPercent");
  if (!progressText) return;

  const normalized = normalizePercent(pct);
  progressText.style.left = `${normalized}%`;

  if (normalized <= 4) {
    progressText.style.transform = "translateX(0) translateY(-50%)";
    progressText.classList.remove("end");
  } else if (normalized >= 96) {
    progressText.style.transform = "translateX(-100%) translateY(-50%)";
    progressText.classList.add("end");
  } else {
    progressText.style.transform = "translateX(-50%) translateY(-50%)";
    progressText.classList.remove("end");
  }
}

async function monitorTransfer() {
  if (!state.transferId) return;

  if (
    state.monitoringTransferId === state.transferId &&
    state.monitorInterval
  ) {
    return;
  }

  if (state.monitorInterval) {
    clearInterval(state.monitorInterval);
  }

  state.monitoringTransferId = state.transferId;
  state.transferCompleted = false;
  state.lastProgressPercent = 0;

  byId("transferDetails").style.display = "block";

  state.monitorInterval = setInterval(async () => {
    try {
      const data = await fetchJSON(`/api/transfers/${state.transferId}`);
      const t = data.transfer;
      let pct = 0;
      if (t.bytes_total > 0 && Number.isFinite(t.bytes_sent)) {
        pct = normalizePercent((t.bytes_sent / t.bytes_total) * 100);
      }

      pct = Math.max(pct, state.lastProgressPercent);
      state.lastProgressPercent = pct;

      const pctNum = pct;
      const transferredText = `${fmtBytes(t.bytes_sent)} of ${fmtBytes(t.bytes_total)}`;
      const elapsed = state.transferStartTime
        ? Math.round((Date.now() - state.transferStartTime) / 1000)
        : 0;
      const elapsedText = elapsed > 59 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
      const speedText = t.speed_mbps ? `${t.speed_mbps.toFixed(2)} MB/s` : "--";

      // Update movable circle color instead of bar
      updateMovableCircleColor(pct);
      // Remove bar and percentage updates
      // byId("bar").style.width = `${pct}%`;
      // byId("progressPercent").textContent = `${pct}%`;
      // setProgressBubblePosition(pctNum);

      const currentStatus =
        t.status === "running" &&
        t.bytes_total > 0 &&
        t.bytes_sent >= t.bytes_total
          ? "Finalizing"
          : t.status;
      const fileName = t.current_file_name || (t.files && t.files.length === 1 ? t.files[0].name : `${t.files?.length || 0} file(s)`);
      const fileSize = t.current_file_size ? fmtBytes(t.current_file_size) : fmtBytes(t.bytes_total);
      const cancelText = state.cancelRequested && t.status === "running" ? " | Cancelling..." : "";
      const displayElapsed = state.cancelRequested && t.status === "running" ? "--" : elapsedText;

      byId("stats").innerHTML =
        `Status: <span class="status-value">${currentStatus}</span>${cancelText} | ${transferredText} | ${speedText} | ${displayElapsed}`;
      setCurrentFileDetails(fileName, fileSize);
      setTransferProgressText(`Sending ${fileName} — ${transferredText}`);

      const etaText = "--";
      byId("transferEta").textContent = `ETA: ${etaText}`;

      byId("transferBadge").textContent = currentStatus.replace(
        /(^\w|\s\w)/g,
        (c) => c.toUpperCase(),
      );
      byId("transferBadge").className = `status-badge status-${t.status}`;
      byId("cancelTransfer").disabled = t.status !== "running";

      if (
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "cancelled"
      ) {
        if (state.transferCompleted) {
          return;
        }
        state.transferCompleted = true;

        clearInterval(state.monitorInterval);
        state.monitorInterval = null;
        byId("cancelTransfer").disabled = true;

        if (t.status === "failed") {
          hideTransferSpinner();
          hideTransferProgress();
          state.currentOperation = null;
          state.cancelRequested = false;
          updateRunningStatus(false); // Reset light red color
          // Only show error if it's a real failure, not if files were received
          if (t.error && !t.error.includes('received') && !t.error.includes('completed')) {
            Toast.error(`❌ Transfer failed: ${t.error}`);
            setStatus(`Transfer failed: ${t.error}`);
          }
          byId("transferEta").textContent = "ETA: --";
        } else if (t.status === "cancelled") {
          hideTransferSpinner();
          hideTransferProgress();
          hideMovableCircle(); // Hide movable circle when cancelled
          state.currentOperation = null;
          state.cancelRequested = false;
          updateRunningStatus(false); // Reset light red color
          // Stop cursor animation
          const statusIndicator = document.querySelector(".status-indicator");
          if (statusIndicator) {
            statusIndicator.classList.remove("active");
            statusIndicator.classList.add("idle");
          }
          Toast.info(`⚠️ Transfer cancelled`);
          setStatus(`Transfer cancelled by user.`);
          byId("transferEta").textContent = "ETA: --";
        } else {
          const timeTaken = state.transferStartTime
            ? Math.round((Date.now() - state.transferStartTime) / 1000)
            : 0;
          const minutes = Math.floor(timeTaken / 60);
          const seconds = timeTaken % 60;
          const timeString =
            minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

          byId("timeTaken").textContent = timeString;
          byId("totalFileSize").textContent = fmtBytes(state.transferTotalSize);
          hideTransferSpinner();
          hideTransferProgress(); // Hide progress bar
          showMovableCircle(); // Show movable circle instead
          state.currentOperation = null;
          state.cancelRequested = false;
          updateRunningStatus(false); // Reset light red color
          
          // Stop cursor animation
          const statusIndicator = document.querySelector(".status-indicator");
          if (statusIndicator) {
            statusIndicator.classList.remove("active");
            statusIndicator.classList.add("idle");
          }

          Toast.success(` Transfer completed in ${timeString}`);
          setStatus(
            `Transfer completed in ${timeString}. Total: ${fmtBytes(state.transferTotalSize)}`,
          );
        }

        const finalPct = t.status === "completed" ? 100 : Number(pct);
        byId("bar").style.width = `${finalPct}%`;
        byId("progressPercent").textContent = `${finalPct}%`;
        setProgressBubblePosition(finalPct);
      }
    } catch (err) {
      clearInterval(state.monitorInterval);
      state.monitorInterval = null;
      state.currentOperation = null;
      hideTransferSpinner();
      const cancelBtn = byId("cancelTransfer");
      if (cancelBtn) cancelBtn.disabled = true;
      // Remove error message completely - don't show any error to user
      // Toast.error(`Transfer monitor error: ${err.message}`);
      // setStatus(`Transfer monitor error: ${err.message}`);
    }
  }, 1000);
}

function monitorReceivingFiles() {
  if (state.receiveMonitorInterval) return;

  state.lastProgressPercent = 0;

  state.receiveMonitorInterval = setInterval(async () => {
    try {
      const response = await fetch("/api/receiving");
      const data = await response.json();
      const progress = data.progress || [];

      if (progress.length === 0) {
        if (state.currentOperation === "receive") {
          hideTransferSpinner();
          hideTransferProgress();
          hideMovableCircle(); // Hide movable circle when receive completes
          updateRunningStatus(false); // Reset light red color
          state.currentOperation = null;
          state.transferId = null;
          byId("cancelTransfer").disabled = true;
          byId("transferBadge").textContent = "Idle";
          byId("transferBadge").className = "status-badge status-idle";
          byId("transferEta").textContent = "ETA: --";
          
          // Stop cursor animation
          const statusIndicator = document.querySelector(".status-indicator");
          if (statusIndicator) {
            statusIndicator.classList.remove("active");
            statusIndicator.classList.add("idle");
          }
          
          setStatus("✅ Receive complete - File ready for use");
        }
        return;
      }

      if (state.currentOperation !== "receive") {
        state.transferStartTime = Date.now();
        // Only set status once when receiving starts
        setStatus(`📥 Receiving ${file.file_name}`);
      }
      state.currentOperation = "receive";
      state.receiveTransfers = progress;
      byId("cancelTransfer").disabled = false;
      byId("transferBadge").textContent = "Receiving";
      byId("transferBadge").className = "status-badge status-sending";
      updateRunningStatus(true); // Set light red color for running status
      byId("transferDetails").style.display = "block";
      showTransferSpinner();
      showTransferProgress(); // This now shows movable circle instead of bar

      const file = progress[0];
      state.transferId = file.transfer_id;
      let pct = normalizePercent(file.progress_percent || 0);
      pct = Math.max(pct, state.lastProgressPercent);
      state.lastProgressPercent = pct;
      const speed = file.speed_mbps ? file.speed_mbps.toFixed(2) : "0.00";
      const eta = file.eta_seconds ? `${file.eta_seconds.toFixed(1)}s` : "--";
      const transferredText = `${fmtBytes(file.bytes_received || 0)} of ${fmtBytes(file.bytes_total || 0)}`;
      const elapsed = state.transferStartTime
        ? Math.round((Date.now() - state.transferStartTime) / 1000)
        : 0;
      const elapsedText = elapsed > 59 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

      // Update movable circle color instead of bar
      updateMovableCircleColor(pct);
      // Remove bar and percentage updates
      // byId("bar").style.width = `${pct}%`;
      // byId("progressPercent").textContent = `${pct}%`;
      // setProgressBubblePosition(pct);
      byId("stats").innerHTML =
        `Status: <span class="status-value">Receiving</span> | ${fmtBytes(file.bytes_received || 0)} of ${fmtBytes(file.bytes_total || 0)} | ${speed} MB/s | ${elapsedText}`;
      setTransferProgressText(`Receiving ${file.file_name} — ${fmtBytes(file.bytes_received || 0)} of ${fmtBytes(file.bytes_total || 0)}`);
      byId("transferEta").textContent = etaText;
      byId("totalFileSize").textContent = fmtBytes(file.bytes_total);
      byId("filesCompleted").textContent = 1;
      setCurrentFileDetails(file.file_name, fmtBytes(file.bytes_total));
      // Don't set status every second to avoid continuous messages
      // setStatus(`Receiving ${file.file_name}`);
    } catch (err) {
      // ignore transient receive polling errors
    }
  }, 1000);
}

function configureDropzone() {
  console.log("Configuring dropzone...");
  const zone = byId("dropzone");
  const fileInput = byId("fileInput");
  
  console.log("Dropzone element:", zone);
  console.log("File input element:", fileInput);

  if (!zone || !fileInput) {
    console.error("Dropzone or file input elements not found!");
    return;
  }

  zone.addEventListener("click", (e) => {
    console.log("Dropzone clicked");
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });

  zone.addEventListener("touchend", (e) => {
    console.log("Dropzone touchend");
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dragover");
  });

  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove("dragover");
    if (event.dataTransfer && event.dataTransfer.files) {
      uploadSelected(event.dataTransfer.files);
    }
  });

  fileInput.addEventListener("change", (event) => {
    if (event.target.files && event.target.files.length > 0) {
      uploadSelected(event.target.files);
    }
  });
}

function configureCopyButton() {
  const copyBtn = byId("copyUrlBtn");
  const urlBox = byId("localUrl");

  if (copyBtn && urlBox) {
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = urlBox.textContent.trim();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(url)
          .then(() => {
            Toast.success("📋 URL Copied to Clipboard");
            const originalText = copyBtn.textContent;
            copyBtn.textContent = "✓";
            copyBtn.style.background = "#10b981";
            setTimeout(() => {
              copyBtn.textContent = originalText;
              copyBtn.style.background = "";
            }, 2000);
          })
          .catch(() => {
            Toast.error("Failed to copy URL");
          });
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand("copy");
          Toast.success("📋 URL Copied to Clipboard");
          copyBtn.textContent = "✓";
          setTimeout(() => {
            copyBtn.textContent = originalText;
          }, 2000);
        } catch (err) {
          Toast.error("Failed to copy URL");
        }
        document.body.removeChild(textarea);
      }
    });
  }
}

function appUrl(ip, port, protocol = state.appProtocol) {
  return `${protocol}://${ip}:${port}`;
}

async function bootstrap() {
  const data = await fetchJSON("/api/local-info");
  state.localAppPort = data.app_port;
  state.localTcpPort = data.tcp_port;
  state.appProtocol = data.protocol || state.appProtocol;
  const hostUrl = appUrl(data.ip, data.app_port);
  byId("localUrl").textContent = hostUrl;

  const localAppPortEl = byId("localAppPort");
  const localTcpPortEl = byId("localTcpPort");
  if (localAppPortEl) localAppPortEl.textContent = data.app_port;
  if (localTcpPortEl) localTcpPortEl.textContent = data.tcp_port;

  const urlListDiv = byId("urlList");
  urlListDiv.innerHTML = "";

  // Only show current IP in URL list
  if (data.ip && data.app_port) {
    const urlItem = document.createElement("div");
    urlItem.className = "url-item";
    urlItem.innerHTML = `
      <code>${appUrl(data.ip, data.app_port)}</code>
      <button class="copy-btn" title="Copy URL" onclick="copyToClipboard('${appUrl(data.ip, data.app_port)}')">📋</button>
    `;
    urlListDiv.appendChild(urlItem);
  }

  await refreshOutbox();
  await refreshInbox();
  Toast.info("✨ FlashDrop Ready - Waiting for peer connection");

  startInboxAutoRefresh();
  monitorReceivingFiles();
}

function configureThemeToggle() {
  const themeToggle = byId("themeToggle");
  const themeIcon = themeToggle?.querySelector(".theme-icon");
  const themeText = themeToggle?.querySelector(".theme-text");
  
  // Load saved theme or default to light mode
  const savedTheme = localStorage.getItem("theme") || "light";
  if (savedTheme === "dark") {
    document.body.classList.add("dark-mode");
    if (themeIcon) themeIcon.textContent = "☀️";
    if (themeText) themeText.textContent = "Light Mode";
  }
  
  themeToggle?.addEventListener("click", () => {
    const isDark = document.body.classList.toggle("dark-mode");
    if (themeIcon) themeIcon.textContent = isDark ? "☀️" : "🌙";
    if (themeText) themeText.textContent = isDark ? "Light Mode" : "Night Shift";
    localStorage.setItem("theme", isDark ? "dark" : "light");
  });
}

window.copyToClipboard = function(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      Toast.success("📋 URL Copied to Clipboard");
    }).catch(() => {
      Toast.error("Failed to copy URL");
    });
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      Toast.success("📋 URL Copied to Clipboard");
    } catch (err) {
      Toast.error("Failed to copy URL");
    }
    document.body.removeChild(textarea);
  }
};

window.addEventListener("DOMContentLoaded", () => {
  console.log("DOM Content Loaded - setting up event listeners");
  
  // Check if elements exist
  const dropzone = byId("dropzone");
  const fileInput = byId("fileInput");
  const connectBtn = byId("connectPeer");
  const peerIpInput = byId("peerIp");
  
  console.log("Elements found:", {
    dropzone: !!dropzone,
    fileInput: !!fileInput,
    connectBtn: !!connectBtn,
    peerIpInput: !!peerIpInput
  });
  
  configureDropzone();
  configureCopyButton();
  configureThemeToggle();

  let allIps = [];
  let appPort = 5000;
  let appProtocol = state.appProtocol;

  // Fetch all IPs for the Show All IPs box
  const loadIpsData = async () => {
    try {
      const response = await fetch("/api/local-info");
      const data = await response.json();
      allIps = data.all_ips || [];
      appPort = data.app_port;
      appProtocol = data.protocol || appProtocol;
    } catch (err) {
      console.error("Failed to load IPs data:", err);
      allIps = [];
    }
  };

  const showAllIpsBtn = byId("showAllIps");
  if (showAllIpsBtn) {
    showAllIpsBtn.addEventListener("click", async () => {
      console.log("Show All IPs button clicked");
      // Load fresh data each time to ensure we have the latest IPs
      await loadIpsData();
      
      const allIpsBox = byId("allIpsBox");
      if (allIpsBox.style.display === "none" || !allIpsBox.style.display) {
        // Get current IP to exclude it from the list
        const currentIp = window.location.hostname;
        console.log("Current IP:", currentIp);
        console.log("All IPs loaded:", allIps);
        
        // Filter out current IP and invalid IPs
        const filteredIps = allIps.filter(ip => 
          ip !== currentIp && 
          !ip.startsWith('127.') && 
          !ip.startsWith('::') && 
          !ip.startsWith('fe80:') &&
          ip !== '0.0.0.0'
        );
        
        console.log("Filtered IPs:", filteredIps);
        
        if (filteredIps.length === 0) {
          allIpsBox.innerHTML = "<p style='color: #64748b;'>No additional IPs found</p>";
        } else {
          allIpsBox.innerHTML = filteredIps
            .map(
              (ip) =>
                `<div style="margin-bottom:4px;"><code>${appUrl(ip, appPort, appProtocol)}</code> <button class='copy-btn' onclick='copyToClipboard("${appUrl(ip, appPort, appProtocol)}")'>📋</button></div>`
            )
            .join("");
        }
        allIpsBox.style.display = "block";
        showAllIpsBtn.textContent = "Hide All IPs";
      } else {
        allIpsBox.style.display = "none";
        showAllIpsBtn.textContent = "Show All IPs";
      }
    });
  }

  const sendBtn = byId("sendFiles");
  const deleteSelectedOutboxBtn = byId("deleteSelectedOutbox");
  const deleteAllOutboxBtn = byId("deleteAllOutbox");
  const deleteSelectedInboxBtn = byId("deleteSelectedInbox");
  const deleteAllInboxBtn = byId("deleteAllInbox");

  if (connectBtn) {
    connectBtn.addEventListener("click", connectPeer);
    addButtonClickAnimation(connectBtn);
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", sendFiles);
    addButtonClickAnimation(sendBtn);
  }

  if (deleteSelectedOutboxBtn) {
    deleteSelectedOutboxBtn.addEventListener("click", deleteSelectedOutbox);
  }

  if (deleteAllOutboxBtn) {
    deleteAllOutboxBtn.addEventListener("click", deleteAllOutbox);
  }

  const selectAllOutboxBtn = byId("selectAllOutbox");
  if (selectAllOutboxBtn) {
    selectAllOutboxBtn.addEventListener("click", toggleSelectAllOutbox);
  }

  const selectAllInboxBtn = byId("selectAllInbox");
  if (selectAllInboxBtn) {
    selectAllInboxBtn.addEventListener("click", toggleSelectAllInbox);
  }

  const cancelTransferBtn = byId("cancelTransfer");
  if (cancelTransferBtn) {
    cancelTransferBtn.addEventListener("click", cancelCurrentTransfer);
  }

  if (deleteSelectedInboxBtn) {
    deleteSelectedInboxBtn.addEventListener("click", deleteSelectedInbox);
  }

  const downloadSelectedInboxBtn = byId("downloadSelectedInbox");
  if (downloadSelectedInboxBtn) {
    downloadSelectedInboxBtn.addEventListener("click", downloadSelectedInbox);
  }

  if (deleteAllInboxBtn) {
    deleteAllInboxBtn.addEventListener("click", deleteAllInbox);
  }

  const refreshOutboxBtn = byId("refreshOutbox");
  if (refreshOutboxBtn) {
    refreshOutboxBtn.addEventListener("click", async () => {
      try {
        await refreshOutbox();
        Toast.info("🔄 Outbox refreshed");
      } catch (err) {
        Toast.error("Failed to refresh outbox");
      }
    });
  }

  const refreshInboxBtn = byId("refreshInbox");
  if (refreshInboxBtn) {
    refreshInboxBtn.addEventListener("click", async () => {
      try {
        await refreshInbox();
        Toast.info("🔄 Inbox refreshed");
      } catch (err) {
        Toast.error("Failed to refresh inbox");
      }
    });
  }

  bootstrap().catch((err) => {
    Toast.error(err.message);
    setStatus(err.message);
  });
  
  // Auto-refresh functionality for real-time updates
  function startAutoRefresh() {
    // Refresh inbox every 3 seconds
    setInterval(async () => {
      try {
        await refreshInbox();
      } catch (err) {
        // Silent refresh errors
      }
    }, 3000);
    
    // Refresh outbox every 5 seconds
    setInterval(async () => {
      try {
        await refreshOutbox();
      } catch (err) {
        // Silent refresh errors
      }
    }, 5000);
  }
  
  // Start auto-refresh after initialization
  setTimeout(() => {
    startAutoRefresh();
  }, 1000);
});
