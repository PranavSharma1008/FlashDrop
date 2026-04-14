const state = {
  peerIp: "",
  tcpPort: 9009,
  outbox: [],
  selected: new Set(),
  transferId: null,
  transferStartTime: null,
  transferTotalSize: 0,
};

const byId = (id) => document.getElementById(id);

// ============= TOAST NOTIFICATION SYSTEM =============
class Toast {
  static create(message, type = 'info', duration = 3000) {
    const container = byId('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '💬';
    if (type === 'success') icon = '✅';
    else if (type === 'error') icon = '❌';
    else if (type === 'info') icon = 'ℹ️';
    
    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-message">${message}</span>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
      if (toast.parentElement) {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 400);
      }
    }, duration);
  }

  static success(message, duration) {
    Toast.create(message, 'success', duration);
  }

  static error(message, duration) {
    Toast.create(message, 'error', duration);
  }

  static info(message, duration) {
    Toast.create(message, 'info', duration);
  }
}

// ============= BUTTON ANIMATION =============
function addButtonClickAnimation(btn) {
  btn.addEventListener('click', function(e) {
    const ripple = document.createElement('span');
    ripple.style.position = 'absolute';
    ripple.style.pointerEvents = 'none';
    this.style.position = 'relative';
    this.style.overflow = 'hidden';
  });
}

// ============= UTILITY FUNCTIONS =============
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function setStatus(text) {
  byId("status").textContent = text;
}

function setButtonLoading(btn, isLoading) {
  if (isLoading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function updateConnectionStatus(isConnected, peerIp = null) {
  const badge = document.querySelector('.status-badge');
  const connectBtn = byId('connectPeer');
  if (isConnected) {
    badge.classList.add('connected');
    badge.textContent = `✓ Connected to ${peerIp}`;
    document.querySelector('.status-indicator').classList.add('active');
    document.querySelector('.status-indicator').classList.remove('idle');
  } else {
    badge.classList.remove('connected');
    badge.textContent = 'Disconnected';
    document.querySelector('.status-indicator').classList.remove('active');
    document.querySelector('.status-indicator').classList.add('idle');
  }
}

function updateFileCountBadge() {
  byId('fileCountBadge').textContent = state.outbox.length;
}

function updateInboxCountBadge(count) {
  byId('inboxCountBadge').textContent = count;
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

// ============= RENDERING FUNCTIONS =============
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
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(file.file_id);
      else state.selected.delete(file.file_id);
    });

    const label = document.createElement("span");
    label.textContent = `${file.name} (${fmtBytes(file.size)})`;

    fileInfo.appendChild(cb);
    fileInfo.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeOutboxFile(file.file_id));

    actions.appendChild(removeBtn);

    li.appendChild(fileInfo);
    li.appendChild(actions);
    list.appendChild(li);
  });
  updateFileCountBadge();
}

function renderInbox(files) {
  const list = byId("inboxList");
  const emptyMsg = byId("emptyInboxMessage");
  list.innerHTML = "";
  
  if (files.length === 0) {
    emptyMsg.style.display = 'block';
  } else {
    emptyMsg.style.display = 'none';
  }
  
  files.forEach((file) => {
    const li = document.createElement("li");

    const fileInfo = document.createElement("div");
    fileInfo.className = "file-info";

    const link = document.createElement("a");
    link.href = `/download/${encodeURIComponent(file.name)}`;
    link.textContent = `${file.name} (${fmtBytes(file.size)})`;

    fileInfo.appendChild(link);

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeInboxFile(file.name));

    actions.appendChild(removeBtn);

    li.appendChild(fileInfo);
    li.appendChild(actions);
    list.appendChild(li);
  });
  updateInboxCountBadge(files.length);
}

async function refreshOutbox() {
  const data = await fetchJSON("/api/outbox");
  state.outbox = data.files || [];
  renderOutbox();
}

async function refreshInbox() {
  const data = await fetchJSON("/api/inbox");
  renderInbox(data.files || []);
}

// ============= FILE MANAGEMENT =============
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
    Toast.success("❌ File Removed");
    setStatus("File removed from inbox.");
    await refreshInbox();
  } catch (err) {
    Toast.error(`Failed to remove file: ${err.message}`);
    setStatus(`Failed to remove file: ${err.message}`);
  }
}

async function uploadSelected(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append("files", f);
  
  setStatus(`Uploading ${files.length} file(s)...`);
  Toast.info(`📁 Adding ${files.length} file(s) to outbox...`);
  
  try {
    await fetchJSON("/api/upload", { method: "POST", body: form });
    Toast.success("📁 File(s) Added to Outbox");
    setStatus("Files added to outbox.");
    await refreshOutbox();
    // Reset file input
    byId('fileInput').value = '';
  } catch (err) {
    Toast.error(`Upload failed: ${err.message}`);
    setStatus(`Upload failed: ${err.message}`);
  }
}

async function connectPeer() {
  const peerIp = byId("peerIp").value.trim();
  if (!peerIp) {
    Toast.error("Please enter receiver IP");
    setStatus("Enter receiver IP first.");
    return;
  }
  
  const connectBtn = byId('connectPeer');
  setButtonLoading(connectBtn, true);
  Toast.info("🔗 Connecting to peer...");
  
  try {
    const appPort = 5000;
    const data = await fetchJSON("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer_ip: peerIp, app_port: appPort }),
    });
    state.peerIp = data.peer_ip;
    state.tcpPort = 9009;
    
    Toast.success(`✅ Connected Successfully to Peer (${state.peerIp})`);
    setStatus(`Connected to peer ${state.peerIp}`);
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
  if (!state.peerIp) {
    Toast.error("Connect to a peer first");
    setStatus("Connect to a peer first.");
    return;
  }
  const file_ids = [...state.selected];
  if (!file_ids.length) {
    Toast.error("Select at least one file to send");
    setStatus("Select at least one file to send.");
    return;
  }
  
  // Calculate total file size
  state.transferTotalSize = state.outbox
    .filter(f => file_ids.includes(f.file_id))
    .reduce((sum, f) => sum + f.size, 0);
  
  const sendBtn = byId('sendFiles');
  setButtonLoading(sendBtn, true);
  Toast.info(`📤 Sending ${file_ids.length} file(s)...`);
  
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
    state.transferStartTime = Date.now();
    
    // Show file size in status
    byId('totalFileSize').textContent = fmtBytes(state.transferTotalSize);
    byId('filesCompleted').textContent = file_ids.length;
    
    Toast.success(`✅ Transfer Started`);
    setStatus(`Transfer started: Sending ${fmtBytes(state.transferTotalSize)}...`);
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

async function monitorTransfer() {
  if (!state.transferId) return;
  
  // Show transfer details
  byId('transferDetails').style.display = 'block';
  
  const timer = setInterval(async () => {
    try {
      const data = await fetchJSON(`/api/transfers/${state.transferId}`);
      const t = data.transfer;
      const pct =
        t.bytes_total > 0
          ? ((t.bytes_sent / t.bytes_total) * 100).toFixed(1)
          : "0.0";
      byId("bar").style.width = `${pct}%`;
      byId("progressPercent").textContent = `${pct}%`;
      byId("stats").innerHTML =
        `Status: <span class="status-value">${t.status}</span> | ${pct}% | ${t.speed_mbps.toFixed(
          2,
        )} MB/s | ETA: ${t.eta_seconds ? t.eta_seconds.toFixed(1) : "-"}s`;
      
      if (t.status === "completed" || t.status === "failed") {
        clearInterval(timer);
        if (t.status === "failed") {
          Toast.error(`❌ Transfer failed: ${t.error}`);
          setStatus(`Transfer failed: ${t.error}`);
        } else {
          // Calculate time taken
          const timeTaken = state.transferStartTime ? 
            Math.round((Date.now() - state.transferStartTime) / 1000) : 0;
          const minutes = Math.floor(timeTaken / 60);
          const seconds = timeTaken % 60;
          const timeString = minutes > 0 ? 
            `${minutes}m ${seconds}s` : `${seconds}s`;
          
          byId('timeTaken').textContent = timeString;
          byId('totalFileSize').textContent = fmtBytes(state.transferTotalSize);
          
          Toast.success(`✅ Transfer Completed in ${timeString}!`);
          setStatus(`Transfer completed in ${timeString}. Total: ${fmtBytes(state.transferTotalSize)}`);
          refreshInbox();
        }
        byId("bar").style.width = '100%';
        byId("progressPercent").textContent = '100%';
      }
    } catch (err) {
      clearInterval(timer);
      Toast.error(`Transfer monitor error: ${err.message}`);
      setStatus(`Transfer monitor error: ${err.message}`);
    }
  }, 1000);
}

// ============= DROPZONE UTILITY =============
function configureDropzone() {
  const zone = byId("dropzone");
  const fileInput = byId("fileInput");
  
  // Click to open file picker
  zone.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });
  
  // Dragging files over dropzone
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.add('dragover');
  });
  
  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  });
  
  zone.addEventListener("dragleave", () => {
    zone.classList.remove('dragover');
  });
  
  // Drop files
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('dragover');
    if (event.dataTransfer && event.dataTransfer.files) {
      uploadSelected(event.dataTransfer.files);
    }
  });
  
  // Ensure file input can be triggered
  fileInput.addEventListener('change', (event) => {
    if (event.target.files && event.target.files.length > 0) {
      uploadSelected(event.target.files);
    }
  });
}

// ============= COPY URL FUNCTIONALITY =============
function configureCopyButton() {
  const copyBtn = byId('copyUrlBtn');
  const urlBox = byId('localUrl');
  
  if (copyBtn && urlBox) {
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = urlBox.textContent.trim();
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          Toast.success('📋 URL Copied to Clipboard');
          const originalText = copyBtn.textContent;
          copyBtn.textContent = '✓';
          copyBtn.style.background = '#10b981';
          setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.background = '';
          }, 2000);
        }).catch(() => {
          Toast.error('Failed to copy URL');
        });
      } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          Toast.success('📋 URL Copied to Clipboard');
          copyBtn.textContent = '✓';
          setTimeout(() => {
            copyBtn.textContent = '📋';
          }, 2000);
        } catch (err) {
          Toast.error('Failed to copy URL');
        }
        document.body.removeChild(textarea);
      }
    });
  }
}

// ============= INITIALIZATION =============
async function bootstrap() {
  const data = await fetchJSON("/api/local-info");
  const hostUrl = `http://${data.ip}:${data.app_port}`;
  byId("localUrl").textContent = hostUrl;
  await refreshOutbox();
  await refreshInbox();
  Toast.info("✨ FlashDrop Ready - Waiting for peer connection");
}

window.refreshInbox = refreshInbox;
window.removeOutboxFile = removeOutboxFile;
window.removeInboxFile = removeInboxFile;
window.Toast = Toast;

// ============= EVENT LISTENERS =============
window.addEventListener("DOMContentLoaded", () => {
  // Dropzone and file input configuration
  configureDropzone();
  
  // Copy button configuration
  configureCopyButton();
  
  // Button click handlers
  const connectBtn = byId("connectPeer");
  const sendBtn = byId("sendFiles");
  
  if (connectBtn) {
    connectBtn.addEventListener("click", connectPeer);
    addButtonClickAnimation(connectBtn);
  }
  
  if (sendBtn) {
    sendBtn.addEventListener("click", sendFiles);
    addButtonClickAnimation(sendBtn);
  }
  
  // Bootstrap app
  bootstrap().catch((err) => {
    Toast.error(err.message);
    setStatus(err.message);
  });
});
  });
}

async function refreshOutbox() {
  const data = await fetchJSON("/api/outbox");
  state.outbox = data.files || [];
  renderOutbox();
}

async function refreshInbox() {
  const data = await fetchJSON("/api/inbox");
  renderInbox(data.files || []);
}

async function removeOutboxFile(fileId) {
  if (!confirm("Remove this file from outbox?")) return;
  try {
    await fetchJSON(`/api/outbox/${fileId}`, { method: "DELETE" });
    setStatus("File removed from outbox.");
    await refreshOutbox();
  } catch (err) {
    setStatus(`Failed to remove file: ${err.message}`);
  }
}

async function removeInboxFile(filename) {
  if (!confirm("Remove this file from inbox?")) return;
  try {
    await fetchJSON(`/api/inbox/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    setStatus("File removed from inbox.");
    await refreshInbox();
  } catch (err) {
    setStatus(`Failed to remove file: ${err.message}`);
  }
}

async function uploadSelected(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append("files", f);
  setStatus(`Uploading ${files.length} file(s)...`);
  await fetchJSON("/api/upload", { method: "POST", body: form });
  setStatus("Files added to outbox.");
  await refreshOutbox();
}

async function connectPeer() {
  const peerIp = byId("peerIp").value.trim();
  if (!peerIp) {
    setStatus("Enter receiver IP first.");
    return;
  }
  const appPort = 5000;
  const tcpPort = 9009;
  const data = await fetchJSON("/api/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peer_ip: peerIp, app_port: appPort }),
  });
  state.peerIp = data.peer_ip;
  state.tcpPort = tcpPort;
  setStatus(`Connected to peer ${state.peerIp}`);
}

async function sendFiles() {
  if (!state.peerIp) {
    setStatus("Connect to a peer first.");
    return;
  }
  const file_ids = [...state.selected];
  if (!file_ids.length) {
    setStatus("Select at least one file to send.");
    return;
  }
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
  setStatus(`Transfer started: ${state.transferId}`);
  monitorTransfer();
}

async function monitorTransfer() {
  if (!state.transferId) return;
  const timer = setInterval(async () => {
    try {
      const data = await fetchJSON(`/api/transfers/${state.transferId}`);
      const t = data.transfer;
      const pct =
        t.bytes_total > 0
          ? ((t.bytes_sent / t.bytes_total) * 100).toFixed(1)
          : "0.0";
      byId("bar").style.width = `${pct}%`;
      byId("stats").textContent =
        `Status: ${t.status} | ${pct}% | ${t.speed_mbps.toFixed(
          2,
        )} MB/s | ETA: ${t.eta_seconds ? t.eta_seconds.toFixed(1) : "-"}s`;
      if (t.status === "completed" || t.status === "failed") {
        clearInterval(timer);
        if (t.status === "failed") setStatus(`Transfer failed: ${t.error}`);
        else setStatus("Transfer completed.");
        refreshInbox();
      }
    } catch (err) {
      clearInterval(timer);
      setStatus(`Transfer monitor error: ${err.message}`);
    }
  }, 1000);
}

function configureDropzone() {
  const zone = byId("dropzone");
  zone.addEventListener("click", () => byId("fileInput").click());
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.style.borderColor = "#2563eb";
    zone.style.background = "#eff6ff";
  });
  zone.addEventListener("dragleave", () => {
    zone.style.borderColor = "#93c5fd";
    zone.style.background = "#eff6ff";
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.style.borderColor = "#93c5fd";
    zone.style.background = "#eff6ff";
    uploadSelected(event.dataTransfer.files);
  });
}

async function bootstrap() {
  const data = await fetchJSON("/api/local-info");
  const hostUrl = `http://${data.ip}:${data.app_port}`;
  byId("localUrl").textContent = hostUrl;
  await refreshOutbox();
  await refreshInbox();
}

window.refreshInbox = refreshInbox;
window.removeOutboxFile = removeOutboxFile;
window.removeInboxFile = removeInboxFile;

window.addEventListener("DOMContentLoaded", () => {
  byId("fileInput").addEventListener("change", (event) =>
    uploadSelected(event.target.files),
  );
  byId("connectPeer").addEventListener("click", connectPeer);
  byId("sendFiles").addEventListener("click", sendFiles);
  configureDropzone();
  bootstrap().catch((err) => setStatus(err.message));
});
