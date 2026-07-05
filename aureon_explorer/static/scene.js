// scene.js — the 3D "retrieval galaxy".
//
// Renders aureon documents as glowing nodes positioned by their real semantic
// (LSA→PCA) coordinates, then dramatizes a search: a query-star ignites and
// fires energy beams (with streaming particles) to the top hits, colored by
// whether each hit was won on meaning (dense/blue) or exact terms (sparse/orange).
//
// Exposes a singleton `scene` with a small imperative API used by app.js.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const IDLE = new THREE.Color("#4a5580");

// Two visual identities. `dark` = the original night-sky (additive glow + bloom).
// `light` = a daylight star-chart: additive glow (great on black, muddy on white)
// is swapped for saturated, normal-blended INK marks and fog matched to paper — so
// the galaxy reads as a vivid printed chart rather than a washed-out smear.
//
// Each theme also carries its own `dense`/`sparse` match colors: the dark palette
// uses bright pastel blue/orange (they pop on black); the light palette uses the
// deeper, more saturated ink variants (pastels vanish on a pale ground). `bloom`
// is star-only in light — a high `bloomThreshold` means only the query-star's
// bright core blooms, so effects gain life without blowing out to white.
const THEMES = {
  dark: {
    fog: 0x05060d, fogDensity: 0.0038, bloom: 0.48, bloomThreshold: 0.28,
    dense: 0x3fa9ff, sparse: 0xff9a3f,
    starCore: 0xeafffb, halo: 0x7af7ff, haloScale: 26, haloOpacity: 1.0, haloAdd: true,
    web: 0x5a78c8, webOpacity: 0.14, webAdd: true,
    beamAdd: true, beamBase: 0.16, beamGain: 0.40,
    particleAdd: true, particleOpacity: 0.95, inkParticles: false,
    starfield: 0x8fa8ff, starfieldOpacity: 0.5,
  },
  light: {
    // Bloom OFF in light: the scene now sits on an opaque light backdrop, and bloom
    // only brightens toward white (invisible on paper) while the pale ground itself
    // would exceed any usable threshold and wash the frame out. "Glow" here comes
    // from saturated ink (beams / particles / hit orbs / halo disc) instead.
    fog: 0xe7eef9, fogDensity: 0.0023, bloom: 0.0, bloomThreshold: 0.5,
    dense: 0x1670cf, sparse: 0xd06a12,
    starCore: 0x17b3d8, halo: 0x0b8fb3, haloScale: 15, haloOpacity: 0.5, haloAdd: false,
    web: 0x41619f, webOpacity: 0.42, webAdd: false,
    beamAdd: false, beamBase: 0.66, beamGain: 0.34,
    particleAdd: false, particleOpacity: 1.0, inkParticles: true,
    starfield: 0x8393b8, starfieldOpacity: 0.32,
  },
};
const _BLEND = (add) => (add ? THREE.AdditiveBlending : THREE.NormalBlending);

// Categorical palette for source-document groups. Deliberately avoids pure
// blue/orange so it never collides with the dense/sparse match colors.
const GROUP_PALETTE = [
  "#8b7cff", "#ff7ab6", "#4dd6a8", "#f5c451", "#c66bff", "#ff6b6b",
  "#38d0e8", "#a3e04d", "#e86ad0", "#6be0c0", "#9db4ff", "#ffab73",
];

class GalaxyScene {
  constructor() {
    this.nodes = [];          // { id, mesh, base:THREE.Vector3, source, text }
    this.byId = new Map();
    this.beams = [];          // { mesh, from, to, color }
    this.star = null;
    this.particles = null;
    this._particleData = null;
    this._hoverCb = () => {};
    this._clickCb = () => {};
    this._camTween = null;
    this._raf = null;
    this._clock = new THREE.Clock();
    this._hovered = null;
    this._labelsVisible = true;
    this._webVisible = true;
    this._web = null;                // faint nearest-neighbor connection mesh
    this.sourceColors = new Map();   // source name -> THREE.Color
  }

  // ── setup ────────────────────────────────────────────────────────────
  init(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060d, 0.0038);
    this._theme = this._theme || "dark";

    this.camera = new THREE.PerspectiveCamera(
      55, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.camera.position.set(0, 30, 180);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.6;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;

    // Lights (mostly for the standard-material sheen; bloom does the glow).
    this.scene.add(new THREE.AmbientLight(0x334466, 1.2));
    const key = new THREE.PointLight(0x7af7ff, 0.8, 0);
    key.position.set(60, 80, 120);
    this.scene.add(key);

    // Overlay renderer for crisp HTML name-labels attached to nodes.
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
    const ld = this.labelRenderer.domElement;
    ld.style.position = "fixed";
    ld.style.top = "0";
    ld.style.left = "0";
    ld.style.pointerEvents = "none";
    ld.style.zIndex = "2";
    document.body.appendChild(ld);

    this._buildStarfield();
    this._buildPostFX();

    // Shared geometry for all nodes.
    this._nodeGeo = new THREE.SphereGeometry(1, 20, 20);

    // Interaction.
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    canvas.addEventListener("pointermove", (e) => this._onMove(e));
    canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    window.addEventListener("resize", () => this._onResize());

    this._animate();
  }

  _buildStarfield() {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 400 + Math.random() * 600;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color: 0x8fa8ff, size: 1.1, transparent: true, opacity: 0.5,
      depthWrite: false,
    });
    this._starMat = m;
    this.scene.add(new THREE.Points(g, m));
    this.setTheme(this._theme);   // apply theme-dependent colors now that stars exist
  }

  _buildPostFX() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.48,  // strength — softer, less blown-out glow
      0.5,   // radius
      0.28   // threshold — only the brightest hits/star really bloom
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // ── nodes ────────────────────────────────────────────────────────────
  setNodes(nodes) {
    this.clearResults();
    for (const n of this.nodes) {
      this.scene.remove(n.mesh);
      if (n.labelEl) n.labelEl.remove();
      if (n.idEl) n.idEl.remove();
    }
    this.nodes = [];
    this.byId.clear();

    // Assign each distinct source document a stable group color.
    this.sourceColors.clear();
    let gi = 0;
    for (const nd of nodes) {
      if (!this.sourceColors.has(nd.source)) {
        const hex = GROUP_PALETTE[gi % GROUP_PALETTE.length];
        this.sourceColors.set(nd.source, new THREE.Color(hex));
        gi++;
      }
    }

    for (const nd of nodes) {
      const mat = new THREE.MeshStandardMaterial({
        color: IDLE.clone(), emissive: IDLE.clone(), emissiveIntensity: 0.8,
        roughness: 0.4, metalness: 0.1,
      });
      const mesh = new THREE.Mesh(this._nodeGeo, mat);
      mesh.position.set(nd.x, nd.y, nd.z);
      mesh.scale.setScalar(1.5);
      mesh.userData.id = nd.id;
      this.scene.add(mesh);

      // Name label — a short human-readable title floating above the node.
      const name = this._nodeName(nd);
      const el = document.createElement("div");
      el.className = "node-label";
      el.textContent = name;
      const label = new CSS2DObject(el);
      label.position.set(0, 2.2, 0);
      label.center.set(0.5, 1);
      mesh.add(label);

      // Number rendered INSIDE the glowing orb.
      const idEl = document.createElement("div");
      idEl.className = "node-id";
      idEl.textContent = String(nd.id);
      const idLabel = new CSS2DObject(idEl);
      idLabel.position.set(0, 0, 0);
      idLabel.center.set(0.5, 0.5);
      mesh.add(idLabel);

      const rec = {
        id: nd.id, mesh, label, labelEl: el, idEl, idLabel, name,
        source: nd.source, text: nd.text,
        groupColor: this.sourceColors.get(nd.source) || IDLE,
        base: new THREE.Vector3(nd.x, nd.y, nd.z),
        phase: Math.random() * Math.PI * 2,
      };
      this.nodes.push(rec);
      this.byId.set(nd.id, rec);
    }
    this.setLabelsVisible(this._labelsVisible);
    this._buildWeb();
    this._resetNodeLooks();
    this._frameCorpus();
  }

  // Faint "constellation" web: link each node to its nearest neighbors so the
  // corpus reads as a connected semantic graph at rest (not just loose dots).
  _buildWeb() {
    if (this._web) {
      this.scene.remove(this._web);
      this._web.geometry.dispose();
      this._web.material.dispose();
      this._web = null;
    }
    if (this.nodes.length < 2) return;
    const K = 3;
    const seen = new Set();
    const verts = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i].base;
      // nearest K neighbors by 3D distance (brute force; fine for this scale)
      const d = [];
      for (let j = 0; j < this.nodes.length; j++) {
        if (j === i) continue;
        d.push([this.nodes[j].base.distanceToSquared(a), j]);
      }
      d.sort((p, q) => p[0] - q[0]);
      for (let n = 0; n < Math.min(K, d.length); n++) {
        const j = d[n][1];
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const b = this.nodes[j].base;
        verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const c = this._cfg();
    const m = new THREE.LineBasicMaterial({
      color: c.web, transparent: true, opacity: c.webOpacity,
      blending: _BLEND(c.webAdd), depthWrite: false,
    });
    this._web = new THREE.LineSegments(g, m);
    this._web.visible = this._webVisible;
    this.scene.add(this._web);
  }

  setWebVisible(on) {
    this._webVisible = on;
    if (this._web) this._web.visible = on;
  }

  _cfg() { return THEMES[this._theme] || THEMES.dark; }

  // Theme-aware match color. dom: 1 => dense/meaning, 0 => sparse/exact terms.
  // Built from the ACTIVE theme so hits read with strong contrast on both the
  // black night-sky (bright pastels) and the pale daylight chart (deep inks).
  _matchColor(dom) {
    const c = this._cfg();
    return new THREE.Color(c.sparse).lerp(new THREE.Color(c.dense), dom);
  }

  // Switch visual identity. The canvas is transparent, so fog is matched to the
  // page background; additive glow (great on black, muddy on white) is swapped
  // for inked normal-blended marks in light, and bloom is dialed to zero so the
  // query-star stops blooming into a white smear. Any in-flight search visuals
  // (star / beams / particles / web) are re-skinned in place.
  setTheme(theme) {
    this._theme = theme === "light" ? "light" : "dark";
    const c = this._cfg();

    if (this.scene && this.scene.fog) {
      this.scene.fog.color.set(c.fog);
      this.scene.fog.density = c.fogDensity;
    }
    // The post-processing composer renders an OPAQUE backdrop, so the transparent
    // canvas can't let the light page show through — in light mode that left the
    // "daylight chart" sitting on a black void. Paint an explicit backdrop matched
    // to the fog so nodes fade into the horizon. Dark keeps its transparent canvas
    // (the CSS radial gradient shows through) — unchanged.
    if (this.scene) {
      this.scene.background = this._theme === "light" ? new THREE.Color(c.fog) : null;
    }
    if (this._starMat) {
      this._starMat.color.set(c.starfield);
      this._starMat.opacity = c.starfieldOpacity;
    }
    if (this.bloom) {
      this.bloom.strength = c.bloom;
      this.bloom.threshold = c.bloomThreshold ?? 0.28;
    }

    if (this._web) {
      const m = this._web.material;
      m.color.set(c.web); m.opacity = c.webOpacity;
      m.blending = _BLEND(c.webAdd); m.needsUpdate = true;
    }
    if (this.star) {
      this.star.material.color.set(c.starCore);
      const halo = this.star.children[0];
      if (halo) {
        halo.material.color.set(c.halo);
        halo.material.opacity = c.haloOpacity;
        halo.material.blending = _BLEND(c.haloAdd);
        halo.material.map = c.inkParticles ? this._dotTexture() : this._glowTexture();
        halo.material.needsUpdate = true;
        halo.scale.setScalar(c.haloScale);
      }
    }
    for (const b of this.beams) {
      const m = b.mesh.material;
      m.color.copy(this._matchColor(b.dom));   // re-ink to the active palette
      m.opacity = c.beamBase + b.weight * c.beamGain;
      m.blending = _BLEND(c.beamAdd); m.needsUpdate = true;
    }
    // Recolor the glowing hit orbs to the active palette (only while a search is
    // on screen; _dom is cleared on reset so non-hits are skipped).
    if (this.beams.length) {
      for (const n of this.nodes) {
        if (n._dom == null) continue;
        const col = this._matchColor(n._dom);
        n.mesh.material.color.copy(col);
        n.mesh.material.emissive.copy(col);
      }
    }
    if (this.particles) {
      const m = this.particles.material;
      m.opacity = c.particleOpacity;
      m.blending = _BLEND(c.particleAdd);
      m.map = c.inkParticles ? this._dotTexture() : this._glowTexture();
      m.needsUpdate = true;
      // Re-tint the streaming particles to the active palette.
      if (this._particleData) {
        const col = this.particles.geometry.attributes.color.array;
        for (let i = 0; i < this._particleData.length; i++) {
          const pc = this._matchColor(this._particleData[i].dom);
          col[i * 3] = pc.r; col[i * 3 + 1] = pc.g; col[i * 3 + 2] = pc.b;
        }
        this.particles.geometry.attributes.color.needsUpdate = true;
      }
    }
  }

  // Build a compact, readable name for a node from its text/source.
  _nodeName(nd) {
    let t = (nd.text || "").replace(/^#+\s*/, "").trim();  // drop md heading marks
    const words = t.split(/\s+/).slice(0, 4).join(" ");
    let title = words.length > 26 ? words.slice(0, 25) + "…" : words;
    if (!title) title = nd.source || "doc";
    return `${nd.id} · ${title}`;
  }

  setLabelsVisible(on) {
    this._labelsVisible = on;
    for (const n of this.nodes) {
      if (n.label) n.label.visible = on;
      if (n.idLabel) n.idLabel.visible = on;
    }
  }

  _resetNodeLooks() {
    for (const n of this.nodes) {
      // Resting color = the node's source-document group color, so uploaded
      // files are visually distinguishable before any search runs.
      const c = n.groupColor || IDLE;
      n.mesh.material.color.copy(c);
      n.mesh.material.emissive.copy(c);
      n.mesh.material.emissiveIntensity = 0.55;
      n.mesh.scale.setScalar(1.5);
      n.mesh.material.opacity = 1;
      n.target = 1.5;
      n._hot = false;
      n._dom = null;   // no longer a hit; skip in theme re-coloring
      if (n.labelEl) n.labelEl.classList.remove("hit");
    }
  }

  // ── source-group API (used by the SOURCES legend) ────────────────────
  getGroups() {
    const counts = new Map();
    for (const n of this.nodes) counts.set(n.source, (counts.get(n.source) || 0) + 1);
    return [...this.sourceColors.entries()].map(([source, color]) => ({
      source, colorHex: "#" + color.getHexString(), count: counts.get(source) || 0,
    }));
  }

  highlightGroup(source, on) {
    for (const n of this.nodes) {
      if (n.source !== source) continue;
      n.mesh.scale.setScalar(on ? (n.target ?? 1.5) * 1.7 : (n.target ?? 1.5));
      if (n.labelEl) n.labelEl.style.opacity = on ? "1" : "";
    }
  }

  focusGroup(source) {
    const pts = this.nodes.filter((n) => n.source === source);
    if (!pts.length) return;
    const c = new THREE.Vector3();
    for (const n of pts) c.add(n.base);
    c.divideScalar(pts.length);
    this._flyTo(c, 90);
  }

  // ── search results dramatization ─────────────────────────────────────
  showResults(data) {
    this.clearResults();   // resets every node to its (dim) group color

    // Dim non-hit nodes so groups recede and the hits pop.
    for (const n of this.nodes) n.mesh.material.emissiveIntensity = 0.28;

    // Only the top hits get the dense-vs-sparse MATCH coloring + glow.
    const hits = data.results;
    if (!hits.length) return;
    for (const h of hits) {
      const rec = this.byId.get(h.id);
      if (!rec) continue;
      const dom = h.dense + h.sparse > 1e-6
        ? h.dense / (h.dense + h.sparse) : 0.5;   // 1 => dense, 0 => sparse
      const col = this._matchColor(dom);
      rec.mesh.material.color.copy(col);
      rec.mesh.material.emissive.copy(col);
      rec.mesh.material.emissiveIntensity = 0.4 + h.fused * 1.7;
      rec.target = 1.6 + h.fused * 3.4;
      rec._dom = dom;
    }
    const centroid = new THREE.Vector3();
    for (const h of hits) {
      const rec = this.byId.get(h.id);
      if (rec) centroid.add(rec.base);
    }
    centroid.divideScalar(hits.length);
    // Pull the star slightly "up/out" so beams read as radiating.
    const starPos = centroid.clone().add(new THREE.Vector3(0, 14, 0));
    this._spawnStar(starPos);

    // Beams + particle streams to each hit.
    const beamSpecs = [];
    for (const h of hits) {
      const rec = this.byId.get(h.id);
      if (!rec) continue;
      const dom = rec._dom ?? 0.5;
      const color = this._matchColor(dom);
      this._spawnBeam(starPos, rec.base, color, h.fused, dom);
      beamSpecs.push({ from: starPos, to: rec.base, color, weight: h.fused, dom });
      // Emphasize this hit's name label (always visible + rank badge).
      rec._hot = true;
      if (rec.labelEl) {
        rec.labelEl.classList.add("hit");
        rec.labelEl.dataset.rank = `#${h.rank}`;
      }
    }
    this._spawnParticles(beamSpecs);

    this._flyTo(centroid, 120);
  }

  _spawnStar(pos) {
    const c = this._cfg();
    const geo = new THREE.SphereGeometry(3.2, 24, 24);
    const mat = new THREE.MeshBasicMaterial({ color: c.starCore });
    const star = new THREE.Mesh(geo, mat);
    star.position.copy(pos);
    // Halo sprite. In light mode the white-cored glow sprite loses its tint on a
    // pale ground, so use the solid-cored texture — a saturated disc reads as a
    // proper glow on paper.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: c.inkParticles ? this._dotTexture() : this._glowTexture(),
      color: c.halo, transparent: true,
      opacity: c.haloOpacity, blending: _BLEND(c.haloAdd), depthWrite: false,
    }));
    halo.scale.setScalar(c.haloScale);
    star.add(halo);
    this.scene.add(star);
    this.star = star;
  }

  _spawnBeam(from, to, color, weight, dom = 0.5) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(0.18 + weight * 0.9, 0.06, len, 8, 1, true);
    geo.translate(0, len / 2, 0);
    geo.rotateX(Math.PI / 2);   // align +Z
    const c = this._cfg();
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: c.beamBase + weight * c.beamGain,
      blending: _BLEND(c.beamAdd), depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from);
    mesh.lookAt(to);
    this.scene.add(mesh);
    this.beams.push({ mesh, from: from.clone(), to: to.clone(), color, weight, dom });
  }

  _spawnParticles(beamSpecs) {
    const perBeam = 14;
    const total = beamSpecs.length * perBeam;
    if (!total) return;
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const data = [];
    let k = 0;
    for (const b of beamSpecs) {
      for (let j = 0; j < perBeam; j++) {
        data.push({
          from: b.from, to: b.to,
          dom: b.dom ?? 0.5,
          t: Math.random(),
          speed: 0.25 + b.weight * 0.9 + Math.random() * 0.2,
        });
        col[k * 3] = b.color.r; col[k * 3 + 1] = b.color.g; col[k * 3 + 2] = b.color.b;
        k++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const c = this._cfg();
    const m = new THREE.PointsMaterial({
      // Slightly larger, solid-cored dots in light mode: a white-cored glow sprite
      // is nearly invisible on a pale ground, so the streams looked dull.
      size: c.inkParticles ? 3.0 : 2.2,
      vertexColors: true, transparent: true, opacity: c.particleOpacity,
      blending: _BLEND(c.particleAdd), depthWrite: false,
      map: c.inkParticles ? this._dotTexture() : this._glowTexture(),
    });
    this.particles = new THREE.Points(g, m);
    this.scene.add(this.particles);
    this._particleData = data;
  }

  clearResults() {
    for (const b of this.beams) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
    }
    this.beams = [];
    if (this.star) { this.scene.remove(this.star); this.star = null; }
    if (this.particles) {
      this.scene.remove(this.particles);
      this.particles.geometry.dispose();
      this.particles.material.dispose();
      this.particles = null; this._particleData = null;
    }
    this._resetNodeLooks();
  }

  // ── external highlight sync (results panel hover) ────────────────────
  highlight(id, on) {
    const rec = this.byId.get(id);
    if (!rec) return;
    rec.mesh.scale.setScalar(on ? (rec.target ?? 1.5) * 1.6 : (rec.target ?? 1.5));
  }

  focus(id) {
    const rec = this.byId.get(id);
    if (rec) this._flyTo(rec.base, 60);
  }

  onNodeHover(cb) { this._hoverCb = cb; }
  onNodeClick(cb) { this._clickCb = cb; }

  // ── camera ───────────────────────────────────────────────────────────
  _frameCorpus() {
    if (!this.nodes.length) return;
    const box = new THREE.Box3();
    for (const n of this.nodes) box.expandByPoint(n.base);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(c);
    this._flyTo(c, Math.max(90, size * 0.9));
  }

  _flyTo(target, dist) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.length() < 1) offset.set(0, 20, 100);
    offset.normalize().multiplyScalar(dist);
    this._camTween = {
      t: 0,
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      fromPos: this.camera.position.clone(),
      toPos: target.clone().add(offset),
    };
  }

  // ── interaction ──────────────────────────────────────────────────────
  _updatePointer(e) {
    this._pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    this._pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }
  _pick() {
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObjects(this.nodes.map((n) => n.mesh));
    return hits.length ? this.byId.get(hits[0].object.userData.id) : null;
  }
  _onMove(e) {
    this._updatePointer(e);
    const rec = this._pick();
    if (rec !== this._hovered) {
      this._hovered = rec;
      document.body.style.cursor = rec ? "pointer" : "default";
      this._hoverCb(rec ? rec.id : null);
    }
  }
  _onDown(e) {
    this._updatePointer(e);
    const rec = this._pick();
    if (rec) this._clickCb(rec.id, rec);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ── zoom / view controls (driven by the on-screen buttons) ───────────
  zoomBy(factor) {
    // Move the camera along its view ray toward/away from the orbit target.
    const dir = this.camera.position.clone().sub(this.controls.target);
    const dist = THREE.MathUtils.clamp(dir.length() * factor, 20, 900);
    this.camera.position.copy(this.controls.target).add(dir.setLength(dist));
    this._camTween = null;   // cancel any in-flight fly-to
  }
  resetView() { this._camTween = null; this._frameCorpus(); }

  // ── loop ─────────────────────────────────────────────────────────────
  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    const dt = Math.min(this._clock.getDelta(), 0.05);
    const t = this._clock.elapsedTime;

    // Node breathing + smooth scale toward target.
    for (const n of this.nodes) {
      const target = n.target ?? 1.5;
      const s = n.mesh.scale.x + (target - n.mesh.scale.x) * 0.12;
      const breathe = 1 + Math.sin(t * 1.5 + n.phase) * 0.04;
      n.mesh.scale.setScalar(s * breathe);
      n.mesh.position.y = n.base.y + Math.sin(t * 0.6 + n.phase) * 0.6;
    }

    // Connection web: gentle breathing, and recede while a search is active
    // so the query beams clearly stand out.
    if (this._web && this._web.visible) {
      const base = this.beams.length ? 0.05 : 0.14;
      this._web.material.opacity = base + Math.sin(t * 0.8) * 0.03;
    }

    // Star pulse.
    if (this.star) {
      const p = 1 + Math.sin(t * 4) * 0.12;
      this.star.scale.setScalar(p);
      this.star.rotation.y += dt * 0.5;
    }

    // Particle streaming.
    if (this.particles && this._particleData) {
      const arr = this.particles.geometry.attributes.position.array;
      const d = this._particleData;
      for (let i = 0; i < d.length; i++) {
        const pt = d[i];
        pt.t += dt * pt.speed;
        if (pt.t > 1) pt.t -= 1;
        const x = pt.from.x + (pt.to.x - pt.from.x) * pt.t;
        const y = pt.from.y + (pt.to.y - pt.from.y) * pt.t;
        const z = pt.from.z + (pt.to.z - pt.from.z) * pt.t;
        arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
      }
      this.particles.geometry.attributes.position.needsUpdate = true;
    }

    // Camera tween.
    if (this._camTween) {
      const tw = this._camTween;
      tw.t = Math.min(1, tw.t + dt * 1.4);
      const e = 1 - Math.pow(1 - tw.t, 3);   // easeOutCubic
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      if (tw.t >= 1) this._camTween = null;
    }

    // Fade labels by distance so a big corpus doesn't turn into a wall of text,
    // and expand the CLOSEST node (or the hovered one) to its full sentence(s)
    // as you zoom in.
    if (this._labelsVisible) {
      const camPos = this.camera.position;
      let closest = null, cd = Infinity;
      for (const n of this.nodes) {
        const d = camPos.distanceTo(n.mesh.position);
        n._d = d;
        if (d < cd) { cd = d; closest = n; }
      }
      const NEAR = 46;   // within this range, reveal the full text
      for (const n of this.nodes) {
        // Fully visible up close, fading out toward the far edge.
        const o = Math.max(0, Math.min(1, 1 - (n._d - 60) / 260));
        n.labelEl.style.opacity = n._hot ? "1" : o.toFixed(2);
        // The in-orb id stays legible a bit farther out than the name.
        const io = Math.max(0, Math.min(1, 1 - (n._d - 90) / 320));
        n.idEl.style.opacity = n._hot ? "1" : io.toFixed(2);

        const expand = (n === this._hovered) || (n === closest && cd < NEAR);
        if (expand !== n._expanded) {
          n._expanded = expand;
          n.labelEl.textContent = expand ? n.text : n.name;
          n.labelEl.classList.toggle("expanded", expand);
          if (expand) n.labelEl.style.opacity = "1";
        }
      }
    }

    this.controls.update();
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  // ── utilities ────────────────────────────────────────────────────────
  _glowTexture() {
    if (this._glowTex) return this._glowTex;
    const s = 64;
    const cvs = document.createElement("canvas");
    cvs.width = cvs.height = s;
    const ctx = cvs.getContext("2d");
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,255,255,0.6)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    this._glowTex = new THREE.CanvasTexture(cvs);
    return this._glowTex;
  }

  // A solid-cored dot (ink drop) with a soft edge — full alpha at the center so it
  // stays visible on a pale background, unlike the white-cored glow sprite. Used
  // for light-mode particle streams.
  _dotTexture() {
    if (this._dotTex) return this._dotTex;
    const s = 64;
    const cvs = document.createElement("canvas");
    cvs.width = cvs.height = s;
    const ctx = cvs.getContext("2d");
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.62, "rgba(255,255,255,1)");
    g.addColorStop(0.85, "rgba(255,255,255,0.75)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    ctx.fill();
    this._dotTex = new THREE.CanvasTexture(cvs);
    return this._dotTex;
  }
}

export const scene = new GalaxyScene();
