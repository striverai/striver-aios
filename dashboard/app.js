const WS_URL = "ws://localhost:7777/ws";
let ws = null;
let isProcessing = false;
let streamingBubble = null;
let streamingText = "";
let cancelledTurn = false;
const stopBtn = document.getElementById("stopBtn");

function updateStopBtn() {
  const active = isProcessing || voice.isSpeaking();
  stopBtn.style.display = active ? "flex" : "none";
  sendBtn.style.display = active ? "none" : "flex";
}

function stopCurrent() {
  cancelledTurn = true;
  voice.stopSpeaking();
  fetch("/stop", { method: "POST" }).catch(() => {});
  hideToolBar();
  setProcessing(false);
  streamingBubble = null; streamingText = "";
  if (!handsFreeActive()) setOrbState("", "SẴN SÀNG");
  updateStopBtn();
}
function handsFreeActive() { return typeof handsFree !== "undefined" && handsFree; }
function currentBrainPath() {
  const v = document.getElementById("graphSource").value;
  return v.startsWith("path:") ? v.slice(5) : "brain";
}

// Elements
const chatArea = document.getElementById("chatArea");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const toolBar = document.getElementById("toolBar");
const toolBarText = document.getElementById("toolBarText");
const voiceBtn = document.getElementById("voiceBtn");
const ttsToggle = document.getElementById("ttsToggle");
const voiceInterim = document.getElementById("voiceInterim");
const orbState = document.getElementById("orbState");

document.getElementById("currentDate").textContent = new Date().toLocaleDateString("vi-VN", {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
});

fetch("/config").then(r => r.json()).then(cfg => {
  document.getElementById("workspaceName").textContent = cfg.workspace_name || "Jarvis OS";
}).catch(() => {});

// ============================================
// Orb state
// ============================================
function setOrbState(state, label) {
  orbState.className = "orb-state " + state;
  orbState.textContent = label;
}

// ============================================
// Voice
// ============================================
const voice = new JarvisVoice({
  lang: "vi-VN",
  onStart: () => {
    voiceBtn.classList.add("recording");
    setOrbState("listening", handsFree ? "ĐANG NGHE • LUÔN" : "ĐANG NGHE");
    voiceInterim.textContent = "";
  },
  onInterim: (text) => { voiceInterim.textContent = text; },
  onTranscript: (text) => {
    voiceBtn.classList.remove("recording");
    voiceInterim.textContent = "";
    if (text) sendMessage(text);
  },
  onEnd: () => {
    voiceBtn.classList.remove("recording");
    // Hands-free: giữ trạng thái chờ nghe lại, đừng reset về SẴN SÀNG cho đỡ nháy
    if (!isProcessing && !handsFree) setOrbState("", "SẴN SÀNG");
  },
  onError: (err) => {
    voiceBtn.classList.remove("recording");
    setOrbState("", "SẴN SÀNG");
    if (err === "not-allowed") alert("Anh cần cấp quyền microphone cho trang này.");
    else if (err === "not-supported") alert("Trình duyệt không hỗ trợ nhận giọng. Dùng Chrome/Edge.");
  }
});

// ============================================
// WebSocket
// ============================================
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => updateSysStatus("active");
  ws.onclose = () => { updateSysStatus("error"); setTimeout(connect, 3000); };
  ws.onerror = () => updateSysStatus("error");
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
}

function handleMessage(data) {
  // Đã bấm ngắt → bỏ qua mọi message của lượt bị huỷ, chỉ reset khi có message kết thúc
  if (cancelledTurn) {
    if (data.type === "response" || data.type === "error") {
      cancelledTurn = false; setProcessing(false); updateStopBtn();
    }
    return;
  }
  if (data.type === "status") {
    setOrbState("thinking", "ĐANG SUY NGHĨ");
    showToolBar(data.content);
  } else if (data.type === "tool_call") {
    showToolBar(data.content);
    if (data.tool) trackMCP(data.tool);
  } else if (data.type === "tool_result") {
    showToolBar("✓ Nhận data — đang phân tích...");
  } else if (data.type === "stream") {
    if (!streamingBubble) { streamingBubble = createStreamingBubble(); streamingText = ""; }
    streamingText += data.content;
    streamingBubble.querySelector(".bubble").innerHTML = markdownToHtml(streamingText);
    scrollBottom();
  } else if (data.type === "response") {
    hideToolBar();
    let bubble;
    if (!streamingBubble) { appendJarvisMessage(data.content); bubble = chatArea.lastChild; }
    else { streamingBubble.querySelector(".bubble").innerHTML = markdownToHtml(data.content); bubble = streamingBubble; streamingBubble = null; streamingText = ""; }
    setProcessing(false);
    if (voice.ttsEnabled) {
      setOrbState("speaking", "ĐANG NÓI");
      voice.speak(data.content);
      const est = data.content.length * 60;
      setTimeout(() => { if (!isProcessing) setOrbState("", "SẴN SÀNG"); }, est);
    } else {
      setOrbState("", "SẴN SÀNG");
    }
    maybeAutoLearn();   // tự học định kỳ trong phiên dài
  } else if (data.type === "error") {
    hideToolBar(); appendJarvisMessage("⚠ " + data.content); setProcessing(false);
    setOrbState("", "SẴN SÀNG");
  } else if (data.type === "system") {
    appendJarvisMessage(data.content);
  }
}

// ============================================
// Messages
// ============================================
function sendMessage(text) {
  const msg = (text || chatInput.value).trim();
  const atts = pendingAttachments.filter(a => a.path);  // chỉ file đã upload xong
  if ((!msg && atts.length === 0) || isProcessing || !ws || ws.readyState !== WebSocket.OPEN) return;
  voice.stopSpeaking();
  appendUserMessage(msg, atts);

  // Soạn message gửi Jarvis (kèm đường dẫn file trong Sources)
  let outMsg = msg;
  if (atts.length) {
    const lines = atts.map(a => `- ${a.path}`).join("\n");
    const src = atts[0].sources || "", attDir = atts[0].attachments || "";
    const ctx =
      `[File đính kèm để ĐỌC (đường dẫn):\n${lines}\n` +
      `Mặc định: chỉ đọc file rồi trả lời, KHÔNG tự lưu đi đâu.\n` +
      `CHỈ khi user yêu cầu rõ (vd "lưu vào source", "ingest", "ghi vào second brain") thì mới: ` +
      `chuyển thành .md (ảnh thì đọc hiểu + mô tả) lưu vào Sources="${src}" (ảnh gốc chuyển vào Attachments="${attDir}"), kèm frontmatter source.]`;
    outMsg = msg
      ? `${ctx}\n\n${msg}`
      : `${ctx}\n\nHãy đọc (các) file trên và phản hồi / tóm tắt nội dung chính.`;
  }

  chatInput.value = ""; chatInput.style.height = "auto";
  clearAttachments();
  cancelledTurn = false;
  setProcessing(true);
  updateStopBtn();
  setOrbState("thinking", "ĐANG SUY NGHĨ");
  ws.send(JSON.stringify({ message: outMsg, brain: currentBrainPath() }));
}

function appendUserMessage(text, attachments) {
  const div = document.createElement("div");
  div.className = "msg msg-user";
  let attHtml = "";
  if (attachments && attachments.length) {
    attHtml = `<div class="msg-attach">` + attachments.map(a =>
      a.preview
        ? `<img src="${a.preview}" alt="${escapeHtml(a.name)}">`
        : `<span class="file-tag">📝 ${escapeHtml(a.name)}</span>`
    ).join("") + `</div>`;
  }
  const textHtml = text ? `<div>${escapeHtml(text)}</div>` : "";
  div.innerHTML = `<div class="bubble">${textHtml}${attHtml}</div>`;
  chatArea.appendChild(div); scrollBottom();
}
function appendJarvisMessage(text) {
  const div = document.createElement("div");
  div.className = "msg msg-jarvis";
  div.innerHTML = `<div class="bubble">${markdownToHtml(text)}</div>`;
  chatArea.appendChild(div); scrollBottom();
}
function createStreamingBubble() {
  const div = document.createElement("div");
  div.className = "msg msg-jarvis";
  div.innerHTML = `<div class="bubble"></div>`;
  chatArea.appendChild(div); scrollBottom();
  return div;
}
function markdownToHtml(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^#{2,3} (.+)$/gm, "<h3>$1</h3>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
}
function escapeHtml(t) { return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function showToolBar(t) { toolBar.style.display = "flex"; toolBarText.textContent = t; }
function hideToolBar() { toolBar.style.display = "none"; }
function setProcessing(s) { isProcessing = s; sendBtn.disabled = s; }
function scrollBottom() { chatArea.scrollTop = chatArea.scrollHeight; }
function updateSysStatus(s) {
  document.getElementById("claudeStatus").className = "mcp-item " + s;
  document.getElementById("ttsStatus").className = "mcp-item " + s;
}

const usedMCPs = new Map();
function trackMCP(toolName) {
  const list = document.getElementById("mcpList");
  let label = toolName, cat = "Tool";
  if (toolName.includes("pos_")) { cat = "POS"; label = "Pancake POS"; }
  else if (/facebook|fb_/i.test(toolName)) { cat = "Ads"; label = "Facebook"; }
  else if (/instagram|ig_/i.test(toolName)) { cat = "Social"; label = "Instagram"; }
  else if (/youtube|yt_/i.test(toolName)) { cat = "Social"; label = "YouTube"; }
  else if (/ga4|analytics/i.test(toolName)) { cat = "Web"; label = "Analytics"; }
  else if (/Read|Grep|Glob|vault/i.test(toolName)) { cat = "Local"; label = "Files/Vault"; }
  else if (toolName.startsWith("mcp__")) { const p = toolName.split("__"); if (p.length >= 3) label = p[2].replace(/_/g, " "); }
  if (!usedMCPs.has(label)) {
    if (list.querySelector(".dim")) list.innerHTML = "";
    const div = document.createElement("div");
    div.className = "mcp-item active";
    div.innerHTML = `⬤ ${label} <span style="color:var(--text3);font-size:10px">· ${cat}</span>`;
    list.appendChild(div); usedMCPs.set(label, div);
  } else {
    const el = usedMCPs.get(label);
    el.classList.add("loading");
    setTimeout(() => el.classList.replace("loading", "active"), 600);
  }
}

// ============================================
// 3D Graph (always visible centerpiece)
// ============================================
const graph3dContainer = document.getElementById("graph3dContainer");
const graphTooltip = document.getElementById("graphTooltip");
const graphStats = document.getElementById("graphStats");
const graphSource = document.getElementById("graphSource");
let jarvisGraph = null;

graph3dContainer.addEventListener("mousemove", (e) => {
  graphTooltip.style.left = (e.clientX + 14) + "px";
  graphTooltip.style.top = (e.clientY + 14) + "px";
});

async function initGraph() {
  // graph3d.js là classic script load trước app.js → class có sẵn ngay
  if (!window.JarvisGraph3D || !window.ForceGraph3D) {
    graphStats.textContent = "⚠ Lỗi tải thư viện 3D (kiểm tra mạng)";
    return;
  }
  jarvisGraph = new JarvisGraph3D(graph3dContainer, graphTooltip);
  await reloadGraph();
}

// Click node trong graph → Jarvis mở & thao tác note đó trong vault
window.onGraphNodeClick = (node) => {
  if (!node) return;
  sendMessage(`Đọc note "${node.label}" (${node.path}) trong second brain, tóm tắt ngắn nội dung chính và đề xuất việc tiếp theo nếu có.`);
};
async function reloadGraph() {
  if (!jarvisGraph) return;
  graphStats.textContent = "Đang tải...";
  const val = graphSource.value;
  const query = val.startsWith("path:")
    ? `path=${encodeURIComponent(val.slice(5))}`
    : `source=${val}`;
  try {
    const data = await jarvisGraph.load(query);
    const stats = data.stats || {};
    const hidden = stats.hidden ? ` · ẩn ${stats.hidden}` : "";
    graphStats.textContent = `${stats.total_notes} note · ${stats.total_links} kết nối${hidden}`;
    renderConceptLabels(data.categories || [], stats.total_notes || 0);
  } catch (e) { graphStats.textContent = "Lỗi: " + e.message; }
}
graphSource.addEventListener("change", () => {
  localStorage.setItem("jarvis.graphSource", graphSource.value);
  reloadGraph();
  loadMemStats();   // bộ nhớ theo vault → đổi vault thì đổi số ký ức
  checkVault();     // kiểm tra cấu trúc vault mới chọn
});

// ============================================
// Kiểm tra cấu trúc vault (Phase 1)
// ============================================
const vaultBanner = document.getElementById("vaultBanner");
const vbText = document.getElementById("vbText");
const vbInit = document.getElementById("vbInit");

async function checkVault() {
  try {
    const d = await (await fetch(`/vault/check?brain=${encodeURIComponent(currentBrainPath())}`)).json();
    if (d.ok && d.missing === 0) {
      vaultBanner.classList.remove("show");
    } else {
      const miss = d.items.filter(i => !i.present).map(i => i.label).join(", ");
      vbText.textContent = d.ok
        ? `Vault chạy được, nhưng thiếu: ${miss}.`
        : `Cấu trúc vault chưa chuẩn cho Jarvis — thiếu: ${miss}.`;
      vaultBanner.classList.add("show");
    }
  } catch (e) {}
}

vbInit.addEventListener("click", async () => {
  vbInit.disabled = true;
  const old = vbInit.textContent;
  vbInit.textContent = "Đang tạo...";
  try {
    const fd = new FormData();
    fd.append("brain", currentBrainPath());
    const d = await (await fetch("/vault/init", { method: "POST", body: fd })).json();
    if (d.ok) {
      vbText.textContent = `✓ Đã tạo: ${(d.created || []).join(", ") || "(đã đủ)"}`;
      vbInit.style.display = "none";
      setTimeout(() => { vaultBanner.classList.remove("show"); vbInit.style.display = ""; checkVault(); }, 2500);
    }
  } catch (e) {}
  vbInit.textContent = old;
  vbInit.disabled = false;
});

document.getElementById("vbClose").addEventListener("click", () => vaultBanner.classList.remove("show"));

// Nhãn concept (HUD brain-region) quanh orb — số liệu THẬT
function renderConceptLabels(categories, total) {
  const container = document.getElementById("conceptLabels");
  container.innerHTML = "";
  if (!categories || !categories.length) return;
  const denom = total || categories.reduce((s, c) => s + c.count, 0);
  const n = Math.min(categories.length, 8);
  for (let i = 0; i < n; i++) {
    const c = categories[i];
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = 50 + Math.cos(angle) * 39;
    const y = 47 + Math.sin(angle) * 35;
    const share = denom ? Math.round((c.count / denom) * 100) : 0;
    const div = document.createElement("div");
    div.className = "concept-label";
    div.style.left = x + "%";
    div.style.top = y + "%";
    div.innerHTML = `<div class="cl-name">${escapeHtml(c.name.toUpperCase())}</div>` +
      `<div class="cl-meta">${c.count} note · <span class="cl-fire">${share}% Vault</span></div>`;
    container.appendChild(div);
    setTimeout(() => div.classList.add("show"), 120 + i * 110);
  }
}

// Brain folder tùy chọn — lưu localStorage, hiện trong dropdown
function loadCustomBrains() {
  const brains = JSON.parse(localStorage.getItem("jarvis.brains") || "[]");
  // Xóa option cũ
  [...graphSource.querySelectorAll("option[data-custom]")].forEach(o => o.remove());
  brains.forEach(b => {
    const opt = document.createElement("option");
    opt.value = "path:" + b.path;
    opt.textContent = "📁 " + b.name;
    opt.dataset.custom = "1";
    graphSource.appendChild(opt);
  });
}
function addCustomBrain(path) {
  const brains = JSON.parse(localStorage.getItem("jarvis.brains") || "[]");
  if (brains.some(b => b.path === path)) return;
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  brains.push({ name, path });
  localStorage.setItem("jarvis.brains", JSON.stringify(brains));
  loadCustomBrains();
}
loadCustomBrains();
// Khôi phục folder đã chọn lần trước (mặc định: brain)
(function restoreGraphSource() {
  const saved = localStorage.getItem("jarvis.graphSource");
  if (saved && [...graphSource.options].some(o => o.value === saved)) {
    graphSource.value = saved;
  } else {
    graphSource.value = "brain";
  }
})();

// ============================================
// Folder picker modal
// ============================================
const folderModal = document.getElementById("folderModal");
const fmList = document.getElementById("fmList");
const fmPath = document.getElementById("fmPath");
const fmHint = document.getElementById("fmHint");
let fmCurrent = "";

async function fmBrowse(path) {
  fmHint.textContent = "Đang tải...";
  try {
    const res = await fetch(`/browse?path=${encodeURIComponent(path || "")}`);
    const data = await res.json();
    fmCurrent = data.path || "";
    fmPath.textContent = fmCurrent || "Ổ đĩa";
    fmList.innerHTML = "";
    if (data.parent !== null && data.parent !== undefined) {
      const up = document.createElement("div");
      up.className = "fm-row up";
      up.innerHTML = `<span class="fm-name">⬆ .. (lên trên)</span>`;
      up.onclick = () => fmBrowse(data.parent);
      fmList.appendChild(up);
    }
    (data.dirs || []).forEach(d => {
      const row = document.createElement("div");
      row.className = "fm-row";
      const mdBadge = d.md ? `<span class="fm-md">${d.md} .md</span>` : "";
      row.innerHTML = `<span class="fm-name">📁 ${d.name}</span>${mdBadge}`;
      row.onclick = () => fmBrowse(d.path);
      fmList.appendChild(row);
    });
    fmHint.textContent = data.here_md ? `${data.here_md} file .md ở đây` : (data.error || "Chọn folder chứa ghi chú");
  } catch (e) {
    fmHint.textContent = "Lỗi: " + e.message;
  }
}

document.getElementById("pickFolderBtn").addEventListener("click", () => {
  folderModal.classList.add("open");
  fmBrowse("");
});
document.getElementById("fmClose").addEventListener("click", () => folderModal.classList.remove("open"));
folderModal.addEventListener("click", (e) => { if (e.target === folderModal) folderModal.classList.remove("open"); });
document.getElementById("fmUse").addEventListener("click", () => {
  if (!fmCurrent) return;
  addCustomBrain(fmCurrent);
  graphSource.value = "path:" + fmCurrent;
  localStorage.setItem("jarvis.graphSource", graphSource.value);
  folderModal.classList.remove("open");
  reloadGraph();
});
window.addEventListener("resize", () => { if (jarvisGraph) jarvisGraph.resize(); });

let _stopBtnTick = 0;
function pumpAudioLevel() {
  if (jarvisGraph) jarvisGraph.setLevel(voice.getLevel());
  // Cập nhật hiển thị nút stop ~6 lần/giây (theo dõi cả lúc Jarvis đang đọc)
  if ((_stopBtnTick++ % 10) === 0) updateStopBtn();
  requestAnimationFrame(pumpAudioLevel);
}
stopBtn.addEventListener("click", stopCurrent);

// ============================================
// Starfield nebula — nền vũ trụ, sáng theo nhịp giọng nói
// ============================================
function initStarfield() {
  const cv = document.getElementById("starfield");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  let stars = [];
  const STAR_COLORS = ["#ffffff", "#c9b3ff", "#b8a3ff", "#d6c9ff"];

  function resize() {
    const rect = cv.parentElement.getBoundingClientRect();
    cv.width = Math.round(rect.width);
    cv.height = Math.round(rect.height);
    // Ít sao + rải đều, mờ — không tạo cụm lạc
    const count = Math.max(40, Math.floor((cv.width * cv.height) / 16000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * cv.width,
      y: Math.random() * cv.height,
      r: Math.random() * 1.0 + 0.2,
      tw: Math.random() * Math.PI * 2,
      sp: Math.random() * 0.04 + 0.006,
      c: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
    }));
  }
  resize();
  window.addEventListener("resize", resize);

  function draw() {
    requestAnimationFrame(draw);
    // Tự đo lại kích thước (sửa lỗi nền dồn 1 góc khi layout chưa xong lúc boot)
    const pw = Math.round(cv.parentElement.getBoundingClientRect().width);
    if (pw > 0 && cv.width !== pw) resize();
    if (!cv.width) return;
    const lvl = voice.getLevel();
    ctx.clearRect(0, 0, cv.width, cv.height);

    // Gradient sáng nhẹ ở TRUNG TÂM — phồng nhẹ theo giọng
    const cx = cv.width / 2, cy = cv.height / 2;
    const rr = Math.min(cv.width, cv.height) * (0.6 + lvl * 0.15);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
    const a = 0.10 + lvl * 0.12;
    g.addColorStop(0, `rgba(140,90,230,${a})`);
    g.addColorStop(0.5, `rgba(90,60,170,${a * 0.4})`);
    g.addColorStop(1, "rgba(8,6,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);

    // Grid floor phối cảnh (HUD command center) — đáy màn hình
    const horizonY = cv.height * 0.72;
    const vpX = cv.width / 2;
    ctx.strokeStyle = `rgba(165,115,230,${0.13 + lvl * 0.10})`;
    ctx.lineWidth = 1;
    const cols = 18;
    for (let i = 0; i <= cols; i++) {
      const fx = (i / cols) * cv.width;
      ctx.beginPath(); ctx.moveTo(fx, cv.height); ctx.lineTo(vpX, horizonY); ctx.stroke();
    }
    const rows = 9;
    for (let j = 1; j <= rows; j++) {
      const t = j / rows;
      const y = horizonY + (cv.height - horizonY) * (t * t);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke();
    }

    // Sao mờ rải đều
    ctx.globalCompositeOperation = "lighter";
    stars.forEach(s => {
      s.tw += s.sp;
      const tw = (Math.sin(s.tw) * 0.35 + 0.45) * (1 + lvl * 0.6);
      ctx.globalAlpha = Math.min(0.85, tw);
      ctx.fillStyle = s.c;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  draw();
}

// ============================================
// Metrics (auto-load số liệu)
// ============================================
const metricCards = document.getElementById("metricCards");
const ACCENTS = ["var(--accent)", "var(--accent2)", "var(--yellow)", "var(--green)", "#06b6d4", "var(--red)"];

async function loadMetrics() {
  const status = document.getElementById("metricStatus");
  status.textContent = "Đang phát hiện MCP & lấy số liệu...";
  metricCards.innerHTML = `<div class="metric-empty">Đang quét các nguồn dữ liệu...</div>`;
  try {
    const res = await fetch("/metrics");
    const data = await res.json();
    const cards = data.cards || [];
    if (cards.length === 0) {
      const note = data.note || data.error || "Chưa có MCP dữ liệu nào kết nối.";
      metricCards.innerHTML = `<div class="metric-empty">${escapeHtml(note)}<br><span class="me-hint">Đấu thêm MCP (POS, Ads, Analytics, Lịch...) để Jarvis báo cáo.</span></div>`;
      status.textContent = "";
      return;
    }
    metricCards.innerHTML = "";
    cards.forEach((c, i) => {
      const accent = ACCENTS[i % ACCENTS.length];
      const trendClass = c.trend === "up" ? "up" : c.trend === "down" ? "down" : "";
      const div = document.createElement("div");
      div.className = "metric-card";
      div.style.setProperty("--card-accent", accent);
      div.innerHTML = `
        <div class="m-label">${escapeHtml(c.label || "")}</div>
        <div class="m-value">${escapeHtml(c.value || "—")}</div>
        <div class="m-sub ${trendClass}">${escapeHtml(c.sub || "")}</div>`;
      metricCards.appendChild(div);
    });
    status.textContent = "Cập nhật: " + new Date().toLocaleTimeString("vi-VN");
  } catch (e) {
    metricCards.innerHTML = `<div class="metric-empty">⚠ Không lấy được số liệu</div>`;
    status.textContent = "";
  }
}
document.getElementById("refreshMetrics").addEventListener("click", loadMetrics);

// ============================================
// Bộ nhớ dài hạn / Tự học
// ============================================
const learnBtn = document.getElementById("learnBtn");
const memResult = document.getElementById("memResult");
const memCount = document.getElementById("memCount");
const autoLearnToggle = document.getElementById("autoLearnToggle");

let reflecting = false;
let turnsSinceReflect = 0;
const AUTO_LEARN_EVERY = 6;   // tự học sau mỗi 6 lượt hội thoại

// Khôi phục cài đặt tự học
let autoLearn = localStorage.getItem("jarvis.autoLearn") !== "off";
if (autoLearnToggle) {
  autoLearnToggle.checked = autoLearn;
  autoLearnToggle.addEventListener("change", () => {
    autoLearn = autoLearnToggle.checked;
    localStorage.setItem("jarvis.autoLearn", autoLearn ? "on" : "off");
  });
}

async function loadMemStats() {
  try {
    const d = await (await fetch(`/memory/stats?brain=${encodeURIComponent(currentBrainPath())}`)).json();
    memCount.textContent = d.facts ?? 0;
  } catch (e) {}
}

async function doReflect(auto) {
  if (reflecting) return;
  reflecting = true;
  turnsSinceReflect = 0;
  if (!auto) { learnBtn.disabled = true; learnBtn.textContent = "🧠 Đang học..."; }
  memResult.textContent = auto ? "🧠 Đang tự học nền..." : "Jarvis đang đọc lại hội thoại và rút ra ký ức...";
  try {
    const fd = new FormData();
    fd.append("brain", currentBrainPath());
    const d = await (await fetch("/reflect", { method: "POST", body: fd })).json();
    if (d.ok) {
      memResult.textContent = (auto ? "🧠 Tự học: " : "") + (d.summary || "Đã học xong.");
      if (d.facts != null) memCount.textContent = d.facts;
    } else {
      memResult.textContent = "⚠ " + (d.error || "Học thất bại");
    }
  } catch (e) {
    memResult.textContent = "⚠ Lỗi mạng";
  } finally {
    reflecting = false;
    if (!auto) { learnBtn.textContent = "🧠 Học từ hội thoại"; learnBtn.disabled = false; }
  }
}

learnBtn.addEventListener("click", () => doReflect(false));

// Tự học định kỳ trong phiên dài — gọi sau mỗi N lượt
function maybeAutoLearn() {
  turnsSinceReflect++;
  if (autoLearn && !reflecting && turnsSinceReflect >= AUTO_LEARN_EVERY) {
    doReflect(true);
  }
}

// ============================================
// File đính kèm → lưu vào Sources
// ============================================
let pendingAttachments = [];
const attachBar = document.getElementById("attachBar");
const fileInput = document.getElementById("fileInput");
const dropOverlay = document.getElementById("dropOverlay");

function renderChips() {
  attachBar.classList.toggle("has-items", pendingAttachments.length > 0);
  attachBar.innerHTML = "";
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip" + (a.uploading ? " uploading" : "");
    const thumb = a.preview
      ? `<img src="${a.preview}" alt="">`
      : `<div class="chip-ico">${a.uploading ? "⏳" : "📝"}</div>`;
    const meta = a.uploading
      ? (a.statusText || "đang xử lý...")
      : (a.statusText ? a.statusText : (fmtSize(a.size) + (a.folder ? ` → ${escapeHtml(a.folder)}` : "")));
    chip.innerHTML = `${thumb}<div class="chip-info"><span class="chip-name">${escapeHtml(a.name)}</span><span class="chip-meta">${meta}</span></div><button class="chip-x" data-i="${i}">✕</button>`;
    attachBar.appendChild(chip);
  });
  attachBar.querySelectorAll(".chip-x").forEach(b =>
    b.addEventListener("click", () => removeAttachment(+b.dataset.i)));
}
function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function removeAttachment(i) {
  const a = pendingAttachments[i];
  if (a && a.preview) URL.revokeObjectURL(a.preview);
  pendingAttachments.splice(i, 1);
  renderChips();
}
function clearAttachments() {
  pendingAttachments.forEach(a => { if (a.preview) URL.revokeObjectURL(a.preview); });
  pendingAttachments = [];
  renderChips();
}

async function uploadFile(file) {
  const isImg = file.type.startsWith("image/");
  const att = {
    name: file.name || "paste.png",
    kind: isImg ? "image" : "file",
    preview: isImg ? URL.createObjectURL(file) : null,
    uploading: true, statusText: "đang tải...", path: null, size: file.size,
    sources: null, attachments: null,
  };
  pendingAttachments.push(att);
  renderChips();
  try {
    // Chỉ STAGE để Jarvis đọc — KHÔNG tự convert/lưu. Lưu Sources chỉ khi user yêu cầu.
    const fd = new FormData();
    fd.append("file", file, att.name);
    fd.append("brain", currentBrainPath());
    const up = await (await fetch("/upload", { method: "POST", body: fd })).json();
    if (!up.ok) { att.uploading = false; att.statusText = "lỗi upload"; renderChips(); return; }
    att.path = up.staged; att.name = up.name; att.size = up.size; att.kind = up.kind;
    att.sources = up.sources; att.attachments = up.attachments;
    att.uploading = false; att.statusText = "";
  } catch (e) {
    att.uploading = false; att.statusText = "lỗi mạng";
  }
  renderChips();
}

document.getElementById("attachBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  [...fileInput.files].forEach(uploadFile);
  fileInput.value = "";
});

// Dán ảnh (Ctrl+V)
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) { uploadFile(f); e.preventDefault(); }
    }
  }
});

// Kéo-thả file
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
    dragDepth++; dropOverlay.classList.add("show");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove("show"); } });
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; dropOverlay.classList.remove("show");
  if (e.dataTransfer?.files) [...e.dataTransfer.files].forEach(uploadFile);
});

// ============================================
// Events
// ============================================
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 90) + "px";
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
sendBtn.addEventListener("click", () => sendMessage());

// Chế độ luôn nghe (hands-free): bấm 1 lần → nghe liên tục đến khi bấm lại
let handsFree = false;
voiceBtn.addEventListener("click", () => {
  if (!voice.isSupported()) { alert("Trình duyệt không hỗ trợ giọng nói. Dùng Chrome/Edge."); return; }
  handsFree = !handsFree;
  voiceBtn.classList.toggle("handsfree", handsFree);
  if (handsFree) {
    voice.startListening();
  } else {
    voice.stopListening();
    setOrbState("", "SẴN SÀNG");
  }
});

// Tự nghe lại khi rảnh (không đang xử lý, không đang nói) — giữ mic sống ở hands-free
setInterval(() => {
  if (handsFree && !voice.isListening && !isProcessing && !voice.isSpeaking()) {
    voice.startListening();
  }
}, 500);

let spacePressed = false;
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !handsFree && !spacePressed && document.activeElement !== chatInput) {
    e.preventDefault(); spacePressed = true; voice.startListening();
  }
  if (e.code === "Escape") {
    handsFree = false; voiceBtn.classList.remove("handsfree");
    voice.stopListening();
    stopCurrent();   // ngắt lệnh đang chạy + dừng đọc
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && spacePressed) { spacePressed = false; voice.stopListening(); }
});

// Reset
document.getElementById("resetBtn").addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: "reset" }));
  chatArea.innerHTML = "";
});

// Voice picker
const voicePickerBtn = document.getElementById("voicePickerBtn");
const voicePopover = document.getElementById("voicePopover");
const rateSlider = document.getElementById("rateSlider");
const rateLabel = document.getElementById("rateLabel");
const savedVoice = localStorage.getItem("jarvis.voice") || "vi-VN-HoaiMyNeural";
const savedRate = parseFloat(localStorage.getItem("jarvis.rate") || "1.10");
document.querySelector(`input[name="voice"][value="${savedVoice}"]`)?.click();
rateSlider.value = savedRate; rateLabel.textContent = savedRate.toFixed(2) + "×";
voice.setVoice(savedVoice); voice.setRate(rateToPct(savedRate));
function rateToPct(r) { const p = ((r - 1) * 100).toFixed(0); return (p >= 0 ? "+" : "") + p + "%"; }
voicePickerBtn.addEventListener("click", (e) => { e.stopPropagation(); voicePopover.classList.toggle("open"); });
document.addEventListener("click", (e) => { if (!voicePopover.contains(e.target) && e.target !== voicePickerBtn) voicePopover.classList.remove("open"); });
document.querySelectorAll('input[name="voice"]').forEach(r => r.addEventListener("change", () => { voice.setVoice(r.value); localStorage.setItem("jarvis.voice", r.value); }));
rateSlider.addEventListener("input", () => { const r = parseFloat(rateSlider.value); rateLabel.textContent = r.toFixed(2) + "×"; voice.setRate(rateToPct(r)); localStorage.setItem("jarvis.rate", r.toString()); });
document.getElementById("testVoiceBtn").addEventListener("click", () => {
  const v = document.querySelector('input[name="voice"]:checked').value;
  voice.speak(v.includes("HoaiMy") ? "Xin chào, em là HoaiMy, trợ lý của anh." : "Xin chào, tôi là NamMinh, trợ lý của bạn.");
});
ttsToggle.addEventListener("click", () => {
  const enabled = voice.toggleTTS();
  ttsToggle.classList.toggle("muted", !enabled);
});

// Resume AudioContext khi user tương tác lần đầu (để analyser pulse hoạt động)
function resumeAudio() {
  try { voice._ensureCtx(); } catch (e) {}
}
document.addEventListener("click", resumeAudio, { once: true });
document.addEventListener("keydown", resumeAudio, { once: true });

// ============================================
// Boot
// ============================================
connect();
initStarfield();
initGraph();
pumpAudioLevel();
loadMemStats();
checkVault();
// Không tự tải số liệu — chỉ tải khi bấm ⟳ hoặc yêu cầu Jarvis
metricCards.innerHTML = `<div class="metric-empty">Bấm <strong>⟳</strong> để tải số liệu kinh doanh,<br>hoặc hỏi Jarvis trực tiếp.<br><span class="me-hint">Số liệu lấy từ MCP bạn đã kết nối.</span></div>`;
