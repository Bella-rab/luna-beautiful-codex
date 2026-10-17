/* Luna Beautiful Codex - Phase 3 extension runtime.
 *
 * One self-contained page function owns every Phase 3 effect: the click/trail canvas,
 * the parallax transforms, the session avatar and the mascot. It is serialised with
 * Function.prototype.toString() and evaluated in the page, so it must stay dependency
 * free and must not close over module scope.
 *
 * Performance contract: no timer, no rAF and no style write happens while the pointer
 * is idle. A single rAF loop drives both effects and the parallax settle; it cancels
 * itself as soon as nothing is animating.
 */

export const EXT_BUILD = "phase3+2026.10.18.1";

export function extRuntime() {
  const FX_ID = "codex-fx-layer";
  const MASCOT_ID = "codex-mascot";
  const AVATAR_CLASS = "codex-user-avatar";
  const AVATAR_STYLE_ID = "codex-avatar-style";
  const Z_FX = 2147483638;
  /* Above the picker host (2147483646) so the mascot stays clickable while the
     panel is open - that is what makes click-to-toggle work from inside it. */
  const Z_MASCOT = 2147483647;

  try { if (window.__lunaExt && typeof window.__lunaExt.destroy === "function") window.__lunaExt.destroy(); } catch (error) {}

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const num = (value, lo, hi, fallback) => { const parsed = Number(value); return Number.isFinite(parsed) ? clamp(parsed, lo, hi) : fallback; };
  const log = (level, text) => {
    const list = (window.__codexExtLog = window.__codexExtLog || []);
    list.push({ t: Date.now(), level, text: String(text).slice(0, 200) });
    if (list.length > 80) list.splice(0, list.length - 80);
  };

  let ext = null;
  let persist = null;
  let canvas = null;
  let ctx = null;
  let dpr = 1;
  let rafId = 0;
  let frames = 0;
  let particles = [];
  let trail = [];
  let lastMoveAt = 0;
  let px = 0;
  let py = 0;
  let tx = 0;
  let ty = 0;
  let targets = [];
  let bound = false;
  let avatarObserver = null;
  let avatarTimer = 0;
  let avatarMissingLogged = false;
  let mascotNode = null;
  let mascotDrag = null;

  const stats = { frames: 0, clicks: 0, trailPoints: 0, running: false, parallaxTargets: 0, avatarNodes: 0, mascot: false };
  window.__lunaFxStats = stats;

  const isOn = () => !!(ext && ext.enabled);
  const fxConfig = () => (ext && ext.fx) || {};
  const clickConfig = () => fxConfig().click || {};
  const trailConfig = () => fxConfig().trail || {};
  const parallaxConfig = () => (ext && ext.parallax) || {};
  const avatarConfig = () => (ext && ext.avatar) || {};
  const mascotConfig = () => (ext && ext.mascot) || {};

  /* ---------- colours ---------- */
  const rgb = hex => {
    const match = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ""));
    const value = match ? parseInt(match[1], 16) : 0x7dd3fc;
    return [value >> 16 & 255, value >> 8 & 255, value & 255];
  };
  const rgba = (hex, alpha) => {
    const c = rgb(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + Math.max(0, Math.min(1, alpha)).toFixed(3) + ")";
  };
  const rainbow = (seed, alpha) => "hsla(" + Math.round((seed * 300 + 190) % 360) + ",92%,64%," + Math.max(0, Math.min(1, alpha)).toFixed(3) + ")";

  /* ---------- fx canvas ---------- */
  const resizeCanvas = () => {
    if (!canvas) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(window.innerWidth * dpr));
    const height = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const ensureCanvas = () => {
    let node = document.getElementById(FX_ID);
    if (!node) {
      node = document.createElement("canvas");
      node.id = FX_ID;
      node.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;pointer-events:none!important;z-index:" + Z_FX + "!important;display:block!important";
      document.body.append(node);
    }
    canvas = node;
    ctx = node.getContext("2d");
    resizeCanvas();
    return node;
  };

  const dropCanvas = () => {
    particles = [];
    trail = [];
    if (canvas) { try { canvas.remove(); } catch (error) {} }
    canvas = null;
    ctx = null;
  };

  const ensureLoop = () => { if (!rafId) rafId = window.requestAnimationFrame(frame); };

  const spawnClick = (x, y) => {
    const config = clickConfig();
    const now = performance.now();
    const size = num(config.size, 40, 240, 96);
    const base = {
      born: now,
      life: config.style === "spark" ? 520 : 560,
      size,
      glow: num(config.glow, 0, 100, 60) / 100,
      opacity: num(config.opacity, 0, 100, 80) / 100,
      blend: config.blend || "screen",
      rainbow: config.colorMode === "rainbow",
      color: config.color || "#7dd3fc"
    };
    stats.clicks += 1;
    if (config.style === "spark") {
      for (let index = 0; index < 10; index += 1) {
        const angle = (Math.PI * 2 * index) / 10 + Math.random() * 0.35;
        particles.push({ ...base, x, y, style: "spark", dx: Math.cos(angle), dy: Math.sin(angle), seed: index / 10 });
      }
    } else {
      particles.push({ ...base, x, y, style: config.style === "ring" ? "ring" : "ripple", seed: Math.random() });
    }
    if (particles.length > 80) particles.splice(0, particles.length - 80);
  };

  const drawParticle = (particle, now, config) => {
    const t = Math.min(1, (now - particle.born) / particle.life);
    const alpha = (1 - t) * particle.opacity;
    if (alpha <= 0.002) return;
    ctx.save();
    ctx.globalCompositeOperation = ["screen", "overlay", "source-over"].indexOf(particle.blend) >= 0 ? particle.blend : "screen";
    ctx.globalAlpha = 1;
    const color = particle.rainbow ? rainbow(particle.seed + t * 0.4, alpha) : rgba(particle.color, alpha);
    const glow = 6 + particle.glow * 26;
    ctx.shadowBlur = particle.glow > 0 ? glow : 0;
    ctx.shadowColor = color;
    if (particle.style === "spark") {
      const distance = particle.size * 0.9 * t;
      const x = particle.x + particle.dx * distance;
      const y = particle.y + particle.dy * distance;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, (1 - t) * (2 + particle.size * 0.05)), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const radius = Math.max(1, particle.size * 0.5 * (0.25 + 0.75 * t));
      if (particle.style === "ring") {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, (1 - t) * 6);
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, (1 - t) * 3);
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = rgba(particle.rainbow ? "#ffffff" : particle.color, alpha * 0.12);
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, radius * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  const drawTrail = (config, now) => {
    if (trail.length < 2) return;
    const length = num(config.length, 80, 800, 240);
    const width = num(config.width, 1, 10, 3);
    const glow = num(config.glow, 0, 100, 60) / 100;
    const opacity = num(config.opacity, 0, 100, 70) / 100;
    const rainbowMode = config.colorMode === "rainbow";
    ctx.save();
    ctx.globalCompositeOperation = ["screen", "overlay", "source-over"].indexOf(config.blend) >= 0 ? config.blend : "screen";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let previous = trail[0];
    let travelled = 0;
    for (let index = 1; index < trail.length; index += 1) {
      const point = trail[index];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      travelled += Math.hypot(dx, dy);
      const fresh = Math.max(0, 1 - travelled / Math.max(40, length));
      if (fresh <= 0) break;
      const age = Math.max(0, 1 - (now - point.t) / 300);
      const alpha = opacity * fresh * age;
      if (alpha <= 0.004) { previous = point; continue; }
      const color = rainbowMode ? rainbow(index / Math.max(1, trail.length), alpha) : rgba(config.color || "#a78bfa", alpha);
      ctx.strokeStyle = color;
      ctx.shadowBlur = glow > 0 ? glow * 22 : 0;
      ctx.shadowColor = color;
      if (config.style === "dots") {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(point.x, point.y, Math.max(1, width * 0.8 * fresh), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = Math.max(0.6, (config.style === "line" ? width * 0.55 : width) * fresh);
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      previous = point;
    }
    ctx.restore();
  };

  /* ---------- parallax ---------- */
  const collectTargets = () => {
    const config = parallaxConfig();
    const ui = num(config.ui, 0, 3, 1);
    const depths = config.depths || {};
    const safe = selector => { try { return document.querySelector(selector); } catch (error) { return null; } };
    const list = [
      { key: "bg", node: document.getElementById("codex-custom-background-base"), depth: num(config.bg, 0, 3, 1) },
      { key: "sidebar", node: safe("aside.app-shell-left-panel"), depth: num(depths.sidebar, 0, 3, 1) * ui },
      { key: "chat", node: safe(".thread-scroll-container"), depth: num(depths.chat, 0, 3, 1) * ui },
      { key: "composer", node: safe("[data-codex-composer-root]"), depth: num(depths.composer, 0, 3, 1) * ui }
    ];
    let bubbles = [];
    try { bubbles = [...document.querySelectorAll("[data-user-message-bubble]")].slice(0, 8); } catch (error) { bubbles = []; }
    for (let index = 0; index < bubbles.length; index += 1) {
      list.push({ key: "bubble" + index, node: bubbles[index], depth: num(depths.bubble, 0, 3, 1) * ui });
    }
    targets = list.filter(item => item.node && item.node !== mascotNode && Math.abs(item.depth) > 0.001);
    stats.parallaxTargets = targets.length;
    return targets;
  };

  const restoreParallax = () => {
    for (const item of targets) {
      try { item.node.style.removeProperty("translate"); item.node.style.removeProperty("transform"); } catch (error) {}
    }
    targets = [];
    px = 0;
    py = 0;
    tx = 0;
    ty = 0;
  };

  const parallaxStep = () => {
    const config = parallaxConfig();
    if (!config.enabled || !isOn()) return false;
    const smooth = num(config.smooth, 0, 100, 60);
    const k = 0.06 + (smooth / 100) * 0.32;
    px += (tx - px) * k;
    py += (ty - py) * k;
    if (Math.abs(tx - px) < 0.0015) px = tx;
    if (Math.abs(ty - py) < 0.0015) py = ty;
    for (const item of targets) {
      const offsetX = (px * 10 * item.depth).toFixed(2);
      const offsetY = (py * 10 * item.depth).toFixed(2);
      /* The switch transitions animate `transform` on the wallpaper layers, and Codex
         itself may use it on UI surfaces. The independent `translate` property composes
         with both, so parallax never fights a transition or wipes a host transform. */
      const want = offsetX + "px " + offsetY + "px";
      if (item.last === want) continue;
      item.last = want;
      try { item.node.style.setProperty("translate", want, "important"); } catch (error) {}
    }
    placeMascot();
    stats.parallaxTargets = targets.length;
    return Math.abs(tx - px) > 0.0015 || Math.abs(ty - py) > 0.0015;
  };

  /* ---------- frame loop ---------- */
  const frame = now => {
    rafId = 0;
    frames += 1;
    stats.frames = frames;
    if (ctx) {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const click = clickConfig();
      particles = particles.filter(particle => now - particle.born < particle.life);
      for (const particle of particles) drawParticle(particle, now, click);
      const trailCfg = trailConfig();
      if (trail.length) {
        if (!trailCfg.enabled || now - lastMoveAt > 200) trail = [];
        else drawTrail(trailCfg, now);
      }
      stats.trailPoints = trail.length;
    }
    const settling = parallaxConfig().enabled ? parallaxStep() : false;
    const busy = particles.length > 0 || trail.length > 1 || settling;
    stats.running = busy;
    if (busy) rafId = window.requestAnimationFrame(frame);
  };

  /* ---------- pointer ---------- */
  const onPointerDown = event => {
    if (!isOn()) return;
    collectTargets();
    if (clickConfig().enabled) { spawnClick(event.clientX, event.clientY); ensureLoop(); }
    if (parallaxConfig().enabled) { tx = (event.clientX / Math.max(1, window.innerWidth) - 0.5) * 2; ty = (event.clientY / Math.max(1, window.innerHeight) - 0.5) * 2; ensureLoop(); }
  };

  const onPointerMove = event => {
    if (!isOn()) return;
    const now = performance.now();
    if (trailConfig().enabled) {
      lastMoveAt = now;
      trail.push({ x: event.clientX, y: event.clientY, t: now });
      if (trail.length > 180) trail.splice(0, trail.length - 180);
      ensureLoop();
    }
    if (parallaxConfig().enabled) {
      tx = (event.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      ty = (event.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
      ensureLoop();
    }
  };

  const onResize = () => { if (canvas) resizeCanvas(); };

  /* ---------- avatar ---------- */
  const AVATAR_CSS = ".codex-user-avatar{position:absolute!important;right:calc(100% + 10px)!important;top:6px!important;display:block!important;pointer-events:none!important;z-index:3!important;background-size:cover!important;background-position:center!important;box-shadow:0 2px 10px #0006!important;overflow:hidden!important}";

  const removeAvatars = () => {
    try { document.querySelectorAll("." + AVATAR_CLASS).forEach(node => node.remove()); } catch (error) {}
    const style = document.getElementById(AVATAR_STYLE_ID);
    if (style) style.remove();
    stats.avatarNodes = 0;
  };

  const syncAvatars = () => {
    const config = avatarConfig();
    const on = isOn() && config.enabled;
    if (!on) { removeAvatars(); return { located: false, count: 0 }; }
    let style = document.getElementById(AVATAR_STYLE_ID);
    if (!style) { style = document.createElement("style"); style.id = AVATAR_STYLE_ID; document.head.append(style); }
    style.textContent = AVATAR_CSS;
    const size = Math.round(num(config.size, 24, 72, 40));
    const radius = num(config.radius, 0, 100, 50) + "%";
    const image = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(config.image || "")) ? String(config.image) : "";
    let bubbles = [];
    try { bubbles = [...document.querySelectorAll("[data-user-message-bubble]")].slice(0, 40); } catch (error) { bubbles = []; }
    if (!bubbles.length) {
      if (!avatarMissingLogged) { avatarMissingLogged = true; log("warn", "avatar anchor not found: [data-user-message-bubble]"); }
      stats.avatarNodes = 0;
      return { located: false, count: 0 };
    }
    avatarMissingLogged = false;
    for (const bubble of bubbles) {
      const parent = bubble.parentElement;
      if (!parent) continue;
      try {
        if (getComputedStyle(parent).position === "static") {
          parent.style.setProperty("position", "relative");
          parent.setAttribute("data-luna-avatar-parent", "1");
        }
      } catch (error) {}
      let node = parent.querySelector(":scope > ." + AVATAR_CLASS);
      if (!node) {
        node = document.createElement("div");
        node.className = AVATAR_CLASS;
        parent.append(node);
      }
      node.style.width = size + "px";
      node.style.height = size + "px";
      node.style.borderRadius = radius;
      if (image) node.style.backgroundImage = "url(\"" + image + "\")";
      else {
        node.style.backgroundImage = "linear-gradient(135deg,#7dd3fc,#a78bfa)";
        node.textContent = "你";
        node.style.color = "#06121f";
        node.style.font = "700 " + Math.round(size * 0.42) + "px/1 'Segoe UI',sans-serif";
        node.style.display = "flex";
        node.style.alignItems = "center";
        node.style.justifyContent = "center";
      }
    }
    stats.avatarNodes = bubbles.length;
    return { located: true, count: bubbles.length };
  };

  const watchAvatars = () => {
    if (avatarObserver) { try { avatarObserver.disconnect(); } catch (error) {} avatarObserver = null; }
    if (!(isOn() && avatarConfig().enabled)) return;
    const box = document.querySelector(".thread-scroll-container");
    if (!box) return;
    avatarObserver = new MutationObserver(() => {
      if (avatarTimer) return;
      avatarTimer = window.setTimeout(() => { avatarTimer = 0; try { syncAvatars(); } catch (error) {} }, 400);
    });
    avatarObserver.observe(box, { childList: true, subtree: true });
  };

  /* ---------- mascot ---------- */
  const FORMS = {
    whale: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><ellipse cx=\"30\" cy=\"37\" rx=\"21\" ry=\"14\" fill=\"#5aa9e6\"/><path d=\"M49 37c6-9 11-6 12 3-6-1-8 2-9 6z\" fill=\"#3f86c4\"/><circle cx=\"19\" cy=\"34\" r=\"2.3\" fill=\"#0b2033\"/><path d=\"M26 47c6 4 13 4 18-1\" stroke=\"#2c6ea8\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"/><path d=\"M27 23c-1-6 3-9 8-9\" stroke=\"#9fd3f5\" stroke-width=\"2.4\" fill=\"none\" stroke-linecap=\"round\"/></svg>",
    cat: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14 26 18 10l12 9z\" fill=\"#f2b56b\"/><path d=\"M50 26 46 10 34 19z\" fill=\"#f2b56b\"/><circle cx=\"32\" cy=\"36\" r=\"17\" fill=\"#f7c98a\"/><circle cx=\"25\" cy=\"34\" r=\"2.4\" fill=\"#221a12\"/><circle cx=\"39\" cy=\"34\" r=\"2.4\" fill=\"#221a12\"/><path d=\"M29 42c1.6 1.6 4.4 1.6 6 0\" stroke=\"#8a5a2b\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"/><path d=\"M12 36h8M12 41h8M44 36h8M44 41h8\" stroke=\"#8a5a2b\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></svg>",
    rabbit: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><ellipse cx=\"24\" cy=\"16\" rx=\"6\" ry=\"14\" fill=\"#f4d7e6\"/><ellipse cx=\"40\" cy=\"16\" rx=\"6\" ry=\"14\" fill=\"#f4d7e6\"/><circle cx=\"32\" cy=\"40\" r=\"16\" fill=\"#fbeaf2\"/><circle cx=\"26\" cy=\"38\" r=\"2.3\" fill=\"#3a2430\"/><circle cx=\"38\" cy=\"38\" r=\"2.3\" fill=\"#3a2430\"/><path d=\"M30 45c1.3 1.3 2.7 1.3 4 0\" stroke=\"#c080a5\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"/></svg>",
    fox: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 28 15 9l14 11z\" fill=\"#ef8b4a\"/><path d=\"M52 28 49 9 35 20z\" fill=\"#ef8b4a\"/><path d=\"M32 18 48 30v10c0 9-7 15-16 15s-16-6-16-15V30z\" fill=\"#f59e5b\"/><path d=\"M32 50c6 0 11-4 13-10-4 2-9 3-13 3s-9-1-13-3c2 6 7 10 13 10z\" fill=\"#fff3e6\"/><circle cx=\"25\" cy=\"33\" r=\"2.3\" fill=\"#2a1a10\"/><circle cx=\"39\" cy=\"33\" r=\"2.3\" fill=\"#2a1a10\"/><path d=\"M32 38v3\" stroke=\"#2a1a10\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
    penguin: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><ellipse cx=\"32\" cy=\"37\" rx=\"16\" ry=\"19\" fill=\"#22304a\"/><ellipse cx=\"32\" cy=\"41\" rx=\"10\" ry=\"14\" fill=\"#f2f6fb\"/><circle cx=\"26\" cy=\"30\" r=\"2.2\" fill=\"#0b1220\"/><circle cx=\"38\" cy=\"30\" r=\"2.2\" fill=\"#0b1220\"/><path d=\"M28 35 36 35 32 40z\" fill=\"#f5a524\"/><ellipse cx=\"18\" cy=\"44\" rx=\"5\" ry=\"9\" fill=\"#22304a\"/><ellipse cx=\"46\" cy=\"44\" rx=\"5\" ry=\"9\" fill=\"#22304a\"/></svg>",
    robot: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"14\" y=\"18\" width=\"36\" height=\"30\" rx=\"9\" fill=\"#9fb6d4\"/><rect x=\"20\" y=\"26\" width=\"24\" height=\"12\" rx=\"5\" fill=\"#16233a\"/><circle cx=\"26\" cy=\"32\" r=\"2.6\" fill=\"#66e0ff\"/><circle cx=\"38\" cy=\"32\" r=\"2.6\" fill=\"#66e0ff\"/><path d=\"M32 18V10\" stroke=\"#9fb6d4\" stroke-width=\"3\"/><circle cx=\"32\" cy=\"8\" r=\"3\" fill=\"#66e0ff\"/><path d=\"M24 48v6M40 48v6\" stroke=\"#9fb6d4\" stroke-width=\"3\" stroke-linecap=\"round\"/></svg>"
  };

  const togglePicker = () => {
    const picker = document.getElementById("codex-wallpaper-picker");
    const shadow = picker && picker.shadowRoot;
    if (!shadow) return false;
    /* Explicit toggle: the launcher itself toggles too, but calling close directly
       keeps the mascot working even if Codex changes the launcher's behaviour. */
    const panel = shadow.querySelector(".panel");
    if (panel && panel.classList.contains("open")) {
      const close = shadow.querySelector(".close");
      if (close) { close.click(); return true; }
    }
    const launcher = shadow.querySelector(".launcher");
    if (launcher) { launcher.click(); return true; }
    return false;
  };

  const saveMascot = () => {
    if (!persist || !mascotNode) return;
    const rect = mascotNode.getBoundingClientRect();
    const x = clamp(((rect.left + rect.width / 2) / Math.max(1, window.innerWidth)) * 100, 0, 100);
    const y = clamp(((rect.top + rect.height / 2) / Math.max(1, window.innerHeight)) * 100, 0, 100);
    try { persist({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) }); } catch (error) {}
  };

  const bindMascot = () => {
    if (!mascotNode || mascotNode.__lunaBound) return;
    mascotNode.__lunaBound = true;
    mascotNode.addEventListener("pointerdown", event => {
      if (!mascotConfig().drag) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = mascotNode.getBoundingClientRect();
      mascotDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      mascotNode.style.cursor = "grabbing";
      try { mascotNode.setPointerCapture(event.pointerId); } catch (error) {}
    });
    mascotNode.addEventListener("pointermove", event => {
      if (!mascotDrag || mascotDrag.id !== event.pointerId) return;
      const dx = event.clientX - mascotDrag.x;
      const dy = event.clientY - mascotDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) mascotDrag.moved = true;
      mascotNode.style.left = (mascotDrag.left + dx) + "px";
      mascotNode.style.top = (mascotDrag.top + dy) + "px";
    });
    const end = event => {
      if (!mascotDrag || mascotDrag.id !== event.pointerId) return;
      const moved = mascotDrag.moved;
      mascotDrag = null;
      mascotNode.style.cursor = "grab";
      if (moved) saveMascot();
      else togglePicker();
    };
    mascotNode.addEventListener("pointerup", end);
    mascotNode.addEventListener("pointercancel", end);
  };

  const placeMascot = () => {
    if (!mascotNode) return;
    const config = mascotConfig();
    const scale = num(config.scale, 0.6, 1.4, 1);
    const depth = parallaxConfig().enabled ? num(parallaxConfig().mascot, 0, 3, 1) : 0;
    const offsetX = (px * 10 * depth).toFixed(2);
    const offsetY = (py * 10 * depth).toFixed(2);
    mascotNode.style.transform = "translate(calc(-50% + " + offsetX + "px), calc(-50% + " + offsetY + "px)) scale(" + scale + ")";
  };

  const ensureMascot = () => {
    const config = mascotConfig();
    const on = isOn() && config.enabled;
    if (!on) {
      if (mascotNode) { try { mascotNode.remove(); } catch (error) {} }
      mascotNode = null;
      stats.mascot = false;
      return;
    }
    if (!mascotNode) {
      mascotNode = document.createElement("div");
      mascotNode.id = MASCOT_ID;
      mascotNode.setAttribute("role", "button");
      mascotNode.title = "点击开合壁纸选择器，可拖动";
      document.body.append(mascotNode);
      bindMascot();
    }
    const size = Math.round(58 * num(config.scale, 0.6, 1.4, 1));
    mascotNode.style.cssText = "position:fixed!important;left:" + num(config.x, 0, 100, 96) + "%!important;top:" + num(config.y, 0, 100, 92) + "%!important;width:" + size + "px!important;height:" + size + "px!important;z-index:" + Z_MASCOT + "!important;pointer-events:auto!important;cursor:grab!important;filter:drop-shadow(0 6px 14px #0007)!important;user-select:none!important;touch-action:none!important";
    const image = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(config.image || "")) ? String(config.image) : "";
    if (image) {
      mascotNode.innerHTML = "";
      const img = document.createElement("img");
      img.src = image;
      img.style.cssText = "width:100%;height:100%;object-fit:contain;pointer-events:none";
      mascotNode.append(img);
    } else {
      mascotNode.innerHTML = FORMS[config.form] || FORMS.whale;
      const svg = mascotNode.querySelector("svg");
      if (svg) { svg.style.width = "100%"; svg.style.height = "100%"; svg.style.pointerEvents = "none"; }
    }
    placeMascot();
    stats.mascot = true;
  };

  /* ---------- public ---------- */
  const apply = next => {
    ext = next && typeof next === "object" ? next : null;
    const on = isOn();
    const fx = fxConfig();
    const wantCanvas = on && ((fx.click && fx.click.enabled) || (fx.trail && fx.trail.enabled));
    if (wantCanvas) { if (!canvas) ensureCanvas(); else resizeCanvas(); }
    else if (canvas) dropCanvas();
    /* Turning parallax off must also undo the offsets it already wrote while the
       extension itself stays on; otherwise stale shifts linger until a reload. */
    const parallaxOn = on && !!parallaxConfig().enabled;
    if (!parallaxOn) restoreParallax();
    syncAvatars();
    ensureMascot();
    watchAvatars();
    if (parallaxOn) collectTargets();
    else stats.parallaxTargets = 0;
    if (parallaxOn) ensureLoop();
    return {
      ok: true,
      enabled: on,
      click: !!(on && fx.click && fx.click.enabled),
      trail: !!(on && fx.trail && fx.trail.enabled),
      parallax: !!(on && parallaxConfig().enabled),
      avatar: !!(on && avatarConfig().enabled),
      mascot: !!(on && mascotConfig().enabled)
    };
  };

  const destroy = () => {
    try { if (rafId) window.cancelAnimationFrame(rafId); } catch (error) {}
    rafId = 0;
    particles = [];
    trail = [];
    dropCanvas();
    restoreParallax();
    removeAvatars();
    if (avatarObserver) { try { avatarObserver.disconnect(); } catch (error) {} avatarObserver = null; }
    if (avatarTimer) { clearTimeout(avatarTimer); avatarTimer = 0; }
    if (mascotNode) { try { mascotNode.remove(); } catch (error) {} mascotNode = null; }
    if (bound) {
      try { window.removeEventListener("pointerdown", onPointerDown, true); } catch (error) {}
      try { window.removeEventListener("pointermove", onPointerMove, true); } catch (error) {}
      try { window.removeEventListener("resize", onResize); } catch (error) {}
    }
    bound = false;
    stats.running = false;
    stats.mascot = false;
  };

  if (!bound) {
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    bound = true;
  }

  return {
    apply,
    destroy,
    /* The panel owns the persisted model, so a drag hands the new position back. */
    setPersist: fn => { persist = typeof fn === "function" ? fn : null; },
    openPicker: togglePicker,
    stats: () => ({ ...stats, avatarLocated: stats.avatarNodes > 0, mascot: !!mascotNode, log: (window.__codexExtLog || []).slice(-10) }),
    refresh: () => apply(ext),
    build: "__LUNA_EXT_BUILD__"
  };
}