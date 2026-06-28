// ============================================
// JARVIS OS — Studio: Agents / Skills / Workflows
// ============================================
(function () {
  const studio = document.getElementById("studio");
  const editor = document.getElementById("studioEditor");
  const brain = () => (window.currentBrainPath ? currentBrainPath() : "brain");
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const api = async (p, o) => (await fetch(p, o)).json();
  const fd = (obj) => { const f = new FormData(); Object.entries(obj).forEach(([k, v]) => f.append(k, v)); return f; };

  document.getElementById("studioOpenBtn").addEventListener("click", () => { studio.classList.add("open"); switchTab("workflows"); });
  document.getElementById("studioClose").addEventListener("click", () => studio.classList.remove("open"));
  document.querySelectorAll(".stab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  function switchTab(tab) {
    document.querySelectorAll(".stab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    ["workflows", "agents", "skills"].forEach(t => document.getElementById("panel-" + t).hidden = (t !== tab));
    if (tab === "workflows") loadWorkflows();
    else if (tab === "agents") loadAgents();
    else loadSkills();
  }

  // ===== Workflows =====
  async function loadWorkflows() {
    const panel = document.getElementById("panel-workflows");
    panel.innerHTML = `<div class="panel-bar"><h3>Workflows</h3><div class="pb-actions"><button class="s-btn-ghost" id="seedBtn">Tạo mẫu</button><button class="s-btn" id="newWf">+ Workflow</button></div></div><div class="cards" id="wfCards">Đang tải...</div>`;
    document.getElementById("newWf").onclick = () => editWorkflow(null);
    document.getElementById("seedBtn").onclick = async () => { await api("/studio/seed", { method: "POST", body: fd({ brain: brain() }) }); loadWorkflows(); };
    const d = await api(`/workflows?brain=${encodeURIComponent(brain())}`);
    const wfs = d.workflows || [];
    const cards = document.getElementById("wfCards");
    if (!wfs.length) { cards.innerHTML = `<div class="empty">Chưa có workflow. Bấm <b>Tạo mẫu</b> để có ví dụ Research → Write, hoặc <b>+ Workflow</b>.</div>`; return; }
    cards.innerHTML = "";
    wfs.forEach(w => {
      const active = w.status === "active";
      const div = document.createElement("div");
      div.className = "wf-card" + (active ? "" : " off");
      div.innerHTML = `
        <div class="wf-top">
          <div class="wf-name">${esc(w.name)} <span class="wf-status ${active ? "on" : "off"}">${active ? "ĐANG BẬT" : "TẮT"}</span></div>
          <label class="toggle"><input type="checkbox" ${active ? "checked" : ""}><span></span></label>
        </div>
        <div class="wf-desc">${esc(w.description || "")}</div>
        <div class="wf-steps">${(w.steps || []).map((s, i) => `<span class="wf-step">${i + 1}·${esc(s.agent)}</span>`).join(" → ")}</div>
        <div class="wf-actions">
          <button class="s-btn run" ${active ? "" : "disabled"}>▶ Chạy</button>
          <button class="s-btn-ghost edit">Sửa</button>
          <button class="s-btn-ghost del">Xoá</button>
        </div>`;
      div.querySelector(".toggle input").onchange = async () => { await api("/workflows/toggle", { method: "POST", body: fd({ slug: w.slug, brain: brain() }) }); loadWorkflows(); };
      div.querySelector(".run").onclick = () => runWorkflow(w);
      div.querySelector(".edit").onclick = () => editWorkflow(w);
      div.querySelector(".del").onclick = async () => { if (confirm(`Xoá workflow "${w.name}"?`)) { await api("/workflows/delete", { method: "POST", body: fd({ slug: w.slug, brain: brain() }) }); loadWorkflows(); } };
      cards.appendChild(div);
    });
  }

  // ===== Run workflow (SSE) =====
  function runWorkflow(w) {
    const input = prompt(`Đầu vào cho "${w.name}" (vd: chủ đề bài viết):`, "");
    if (input === null) return;
    const drawer = document.getElementById("runDrawer");
    const stepsEl = document.getElementById("runSteps");
    document.getElementById("runTitle").textContent = `▶ ${w.name}`;
    stepsEl.innerHTML = `<div class="run-info">Đang khởi động...</div>`;
    drawer.classList.add("open");
    const url = `/workflows/run?slug=${encodeURIComponent(w.slug)}&brain=${encodeURIComponent(brain())}&input=${encodeURIComponent(input)}`;
    const es = new EventSource(url);
    const stepDivs = {};
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.type === "start") {
        stepsEl.innerHTML = `<div class="run-info">${d.steps} bước · workflow ${esc(d.workflow)}</div>`;
      } else if (d.type === "step_start") {
        const div = document.createElement("div");
        div.className = "run-step";
        div.innerHTML = `<div class="rs-head"><span class="rs-num">${d.i + 1}</span><span class="rs-agent">${esc(d.agent)}</span><span class="rs-spin"></span></div><div class="rs-task">${esc(d.task)}</div><div class="rs-out" id="rs-out-${d.i}"></div>`;
        stepsEl.appendChild(div); stepDivs[d.i] = div;
        stepsEl.scrollTop = stepsEl.scrollHeight;
      } else if (d.type === "step_text") {
        const out = document.getElementById(`rs-out-${d.i}`);
        if (out) { out.textContent += d.content; stepsEl.scrollTop = stepsEl.scrollHeight; }
      } else if (d.type === "step_tool") {
        const div = stepDivs[d.i];
        if (div) div.querySelector(".rs-head").insertAdjacentHTML("beforeend", `<span class="rs-tool">⚙ ${esc(d.tool)}</span>`);
      } else if (d.type === "step_done") {
        const div = stepDivs[d.i];
        if (div) { div.classList.add("done"); const sp = div.querySelector(".rs-spin"); if (sp) sp.outerHTML = `<span class="rs-ok">✓</span>`; const out = document.getElementById(`rs-out-${d.i}`); if (out && !out.textContent.trim()) out.textContent = d.output; }
      } else if (d.type === "step_error") {
        const out = document.getElementById(`rs-out-${d.i}`); if (out) out.innerHTML += `<div class="rs-err">⚠ ${esc(d.content)}</div>`;
      } else if (d.type === "done") {
        es.close();
        stepsEl.insertAdjacentHTML("beforeend", `<div class="run-info done">✓ Workflow hoàn tất</div>`);
        stepsEl.scrollTop = stepsEl.scrollHeight;
      }
    };
    es.onerror = () => es.close();
    document.getElementById("runClose").onclick = () => { es.close(); drawer.classList.remove("open"); };
  }

  // ===== Workflow editor =====
  let agentsCache = [];
  async function editWorkflow(w) {
    const ad = await api(`/agents?brain=${encodeURIComponent(brain())}`);
    agentsCache = ad.agents || [];
    if (!agentsCache.length) { alert("Chưa có agent nào. Hãy tạo Agent trước (tab Agents) hoặc bấm Tạo mẫu."); return; }
    const box = document.getElementById("editorBox");
    const steps = w ? JSON.parse(JSON.stringify(w.steps || [])) : [{ agent: agentsCache[0].slug, task: "" }];
    const opts = (sel) => agentsCache.map(a => `<option value="${a.slug}" ${a.slug === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    function render() {
      box.innerHTML = `
        <h3>${w ? "Sửa" : "Tạo"} Workflow</h3>
        <label>Tên</label><input id="wfName" value="${esc(w ? w.name : "")}">
        <label>Mô tả</label><input id="wfDesc" value="${esc(w ? w.description : "")}">
        <label>Các bước (mỗi bước = 1 agent · dùng {{input}} và {{prev}})</label>
        <div id="stepList"></div>
        <button class="s-btn-ghost" id="addStep">+ Bước</button>
        <div class="editor-actions"><button class="s-btn-ghost" id="cancelEd">Huỷ</button><button class="s-btn" id="saveWf">Lưu</button></div>`;
      const sl = box.querySelector("#stepList"); sl.innerHTML = "";
      steps.forEach((st, i) => {
        const row = document.createElement("div"); row.className = "step-row";
        row.innerHTML = `<div class="step-num">${i + 1}</div><select class="st-agent">${opts(st.agent)}</select><textarea class="st-task" rows="2" placeholder="Nhiệm vụ...">${esc(st.task)}</textarea><button class="st-del">✕</button>`;
        row.querySelector(".st-del").onclick = () => { steps.splice(i, 1); if (!steps.length) steps.push({ agent: agentsCache[0].slug, task: "" }); render(); };
        sl.appendChild(row);
      });
      box.querySelector("#addStep").onclick = () => { captureSteps(); steps.push({ agent: agentsCache[0].slug, task: "" }); render(); };
      box.querySelector("#cancelEd").onclick = () => editor.classList.remove("open");
      box.querySelector("#saveWf").onclick = async () => {
        const name = box.querySelector("#wfName").value.trim(); if (!name) return alert("Nhập tên");
        captureSteps();
        await api("/workflows", { method: "POST", body: fd({ name, description: box.querySelector("#wfDesc").value, steps: JSON.stringify(steps), status: w ? w.status : "active", slug: w ? w.slug : "", brain: brain() }) });
        editor.classList.remove("open"); loadWorkflows();
      };
    }
    function captureSteps() {
      box.querySelectorAll(".step-row").forEach((r, i) => { steps[i] = { agent: r.querySelector(".st-agent").value, task: r.querySelector(".st-task").value }; });
    }
    render(); editor.classList.add("open");
  }

  // ===== Agents =====
  async function loadAgents() {
    const panel = document.getElementById("panel-agents");
    panel.innerHTML = `<div class="panel-bar"><h3>Agents</h3><button class="s-btn" id="newAgent">+ Agent</button></div><div class="cards" id="agCards">Đang tải...</div>`;
    document.getElementById("newAgent").onclick = () => editAgent(null);
    const d = await api(`/agents?brain=${encodeURIComponent(brain())}`);
    const cards = document.getElementById("agCards");
    if (!(d.agents || []).length) { cards.innerHTML = `<div class="empty">Chưa có agent. Bấm <b>+ Agent</b> để tạo (vai trò + skills + bộ nhớ riêng).</div>`; return; }
    cards.innerHTML = "";
    d.agents.forEach(a => {
      const div = document.createElement("div"); div.className = "ag-card";
      div.innerHTML = `<div class="ag-name">🤖 ${esc(a.name)} <span class="ag-model">${esc(a.model || "")}</span></div><div class="ag-role">${esc(a.role)}</div><div class="ag-skills">${(a.skills || []).map(s => `<span class="chip-skill">${esc(s)}</span>`).join("") || '<span class="dim">chưa gán skill</span>'}</div><div class="wf-actions"><button class="s-btn-ghost edit">Sửa</button><button class="s-btn-ghost del">Xoá</button></div>`;
      div.querySelector(".edit").onclick = () => editAgent(a);
      div.querySelector(".del").onclick = async () => { if (confirm(`Xoá agent "${a.name}"?`)) { await api("/agents/delete", { method: "POST", body: fd({ slug: a.slug, brain: brain() }) }); loadAgents(); } };
      cards.appendChild(div);
    });
  }

  async function editAgent(a) {
    const sd = await api(`/skills?brain=${encodeURIComponent(brain())}`);
    const skills = sd.skills || [];
    const box = document.getElementById("editorBox");
    box.innerHTML = `<h3>${a ? "Sửa" : "Tạo"} Agent</h3>
      <label>Tên</label><input id="agName" value="${esc(a ? a.name : "")}">
      <label>Vai trò (mô tả ngắn)</label><input id="agRole" value="${esc(a ? a.role : "")}">
      <label>System prompt (cách làm việc chi tiết)</label><textarea id="agPrompt" rows="4">${esc(a ? (a.prompt || "") : "")}</textarea>
      <label>Skills</label><div class="skill-pick" id="skillPick">${skills.length ? skills.map(s => `<label class="sp"><input type="checkbox" value="${esc(s.slug)}" ${a && (a.skills || []).includes(s.slug) ? "checked" : ""}> ${esc(s.name)}</label>`).join("") : '<span class="dim">Vault chưa có skill trong .claude/skills — vẫn tạo agent được, gán skill sau.</span>'}</div>
      <label>Model</label><select id="agModel"><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option></select>
      <div class="editor-actions"><button class="s-btn-ghost" id="cancelEd">Huỷ</button><button class="s-btn" id="saveAg">Lưu</button></div>`;
    if (a && a.model) box.querySelector("#agModel").value = a.model;
    box.querySelector("#cancelEd").onclick = () => editor.classList.remove("open");
    box.querySelector("#saveAg").onclick = async () => {
      const name = box.querySelector("#agName").value.trim(); if (!name) return alert("Nhập tên");
      const sk = [...box.querySelectorAll("#skillPick input:checked")].map(c => c.value).join(",");
      await api("/agents", { method: "POST", body: fd({ name, role: box.querySelector("#agRole").value, prompt: box.querySelector("#agPrompt").value, skills: sk, model: box.querySelector("#agModel").value, slug: a ? a.slug : "", brain: brain() }) });
      editor.classList.remove("open"); loadAgents();
    };
    editor.classList.add("open");
  }

  // ===== Skills =====
  async function loadSkills() {
    const panel = document.getElementById("panel-skills");
    panel.innerHTML = `<div class="panel-bar"><h3>Skills khả dụng</h3><span class="dim">đọc từ .claude/skills và .agents của vault</span></div><div class="cards" id="skCards">Đang tải...</div>`;
    const d = await api(`/skills?brain=${encodeURIComponent(brain())}`);
    const cards = document.getElementById("skCards");
    if (!(d.skills || []).length) { cards.innerHTML = `<div class="empty">Vault chưa có skill trong <code>.claude/skills</code> hoặc <code>.agents</code>. Cài skill vào đó để agent dùng.</div>`; return; }
    cards.innerHTML = "";
    d.skills.forEach(s => { const div = document.createElement("div"); div.className = "sk-card"; div.innerHTML = `<div class="sk-name">🧩 ${esc(s.name)}</div><div class="sk-desc">${esc(s.description || "")}</div><div class="sk-src">${esc(s.source)}</div>`; cards.appendChild(div); });
  }
})();
