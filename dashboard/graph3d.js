// ============================================
// JARVIS OS — 3D Graph (V.A.U.L.T. nebula HUD)
// Node = sprite phát sáng additive (glow) → khối cầu tinh vân như chase.h.ai.
// Dùng window.THREE global (load trước 3d-force-graph) + ForceGraph3D UMD.
// ============================================

const _texCache = {};
function glowTexture(THREE, hex) {
  if (_texCache[hex]) return _texCache[hex];
  const s = 96;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");      // lõi trắng nóng
  g.addColorStop(0.18, hexA(hex, 0.95));
  g.addColorStop(0.45, hexA(hex, 0.45));
  g.addColorStop(1, hexA(hex, 0));               // viền tan vào nền
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  _texCache[hex] = tex;
  return tex;
}
function hexA(hex, a) {
  const m = hex.replace("#", "");
  const r = parseInt(m.substring(0, 2), 16);
  const g = parseInt(m.substring(2, 4), 16);
  const b = parseInt(m.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

class JarvisGraph3D {
  constructor(container, tooltip) {
    this.container = container;
    this.tooltip = tooltip;
    this.graph = null;
    this.level = 0;
    this._smooth = 0;
    this._raf = null;
    this._sprites = [];
  }

  async load(query = "source=all") {
    const res = await fetch(`/graph?${query}`);
    const data = await res.json();
    const links = data.edges.map(e => ({ source: e.source, target: e.target }));
    const THREE = window.THREE;

    if (!this.graph) {
      if (!window.ForceGraph3D) throw new Error("Thư viện 3D chưa tải (kiểm tra mạng)");
      if (!THREE) throw new Error("THREE chưa tải");

      this.graph = ForceGraph3D()(this.container)
        .backgroundColor("rgba(0,0,0,0)")
        .showNavInfo(false)
        .nodeThreeObject(n => {
          const mat = new THREE.SpriteMaterial({
            map: glowTexture(THREE, n.color || "#b98cff"),
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
          });
          const sp = new THREE.Sprite(mat);
          const base = 5 + Math.min(26, (n.links || 0) * 1.8);
          sp.scale.set(base, base, 1);
          sp.__base = base;
          n.__sprite = sp;
          return sp;
        })
        .nodeThreeObjectExtend(false)
        .linkColor(() => "rgba(170,150,255,0.5)")
        .linkWidth(0)
        .linkOpacity(0.11)                         // mờ → mềm mại, không thô
        .linkDirectionalParticles(1)
        .linkDirectionalParticleWidth(0.7)         // hạt nhỏ, dịu
        .linkDirectionalParticleColor(() => "rgba(225,210,255,0.65)")
        .linkDirectionalParticleSpeed(0.0035)
        .onNodeHover(n => {
          this.container.style.cursor = n ? "pointer" : "grab";
          if (n && this.tooltip) {
            this.tooltip.style.display = "block";
            this.tooltip.innerHTML = `<strong>${n.label}</strong><br><span class="tt-path">${n.path}</span><br><span class="tt-links">${n.links} kết nối · click để mở</span>`;
          } else if (this.tooltip) {
            this.tooltip.style.display = "none";
          }
        })
        .onNodeClick(n => {
          const dist = 90;
          const r = 1 + dist / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
          this.graph.cameraPosition({ x: (n.x || 0) * r, y: (n.y || 0) * r, z: (n.z || 0) * r }, n, 800);
          if (window.onGraphNodeClick) window.onGraphNodeClick(n);
        });

      // Layout cầu chặt: lực đẩy vừa, link ngắn
      this.graph.d3Force("charge").strength(-45);
      const linkForce = this.graph.d3Force("link");
      if (linkForce) linkForce.distance(28);

      const controls = this.graph.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.6;   // quay nhẹ liên tục — luôn "sống"

      this._animate();
    }

    this.graph.graphData({ nodes: data.nodes, links });
    // Gom sprite refs
    setTimeout(() => {
      this._sprites = this.graph.graphData().nodes.map(n => n.__sprite).filter(Boolean);
    }, 200);
    this.resize();
    return data;
  }

  setLevel(l) { this.level = l; }

  _animate() {
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      if (!this.graph) return;
      const t = this.level || 0;
      if (t > this._smooth) this._smooth += (t - this._smooth) * 0.5;
      else this._smooth += (t - this._smooth) * 0.12;
      const lvl = this._smooth;

      // Pulse từng sprite: phồng + sáng theo nhịp giọng
      const pulse = 1 + lvl * 1.6;
      const op = Math.min(1, 0.85 + lvl * 0.6);
      for (const sp of this._sprites) {
        if (!sp) continue;
        const b = sp.__base;
        sp.scale.set(b * pulse, b * pulse, 1);
        if (sp.material) sp.material.opacity = op;
      }

      // Quay tròn nhẹ liên tục — tự xoay scene (TrackballControls không có autoRotate)
      const scene = this.graph.scene && this.graph.scene();
      if (scene) scene.rotation.y += 0.0018 + lvl * 0.012;

      // Synapse bắn nhanh hơn khi nói (throttle 6 frame/lần cho nhẹ)
      this._frame = (this._frame || 0) + 1;
      if (this._frame % 6 === 0) {
        this.graph.linkDirectionalParticleSpeed(0.005 + lvl * 0.022);
      }
    };
    tick();
  }

  resize() {
    if (this.graph) {
      this.graph.width(this.container.clientWidth);
      this.graph.height(this.container.clientHeight);
    }
  }

  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
  resume() { if (!this._raf) this._animate(); }
}

window.JarvisGraph3D = JarvisGraph3D;
window.dispatchEvent(new Event("jarvis-graph3d-ready"));
