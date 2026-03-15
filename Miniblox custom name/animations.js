// animations.js — Miniblox Cinematic Username Banner
// Version: 4.2.2
//
// ✅ 10s delay before appearing
// ✅ Banner starts far away (tiny), approaches realistically with perspective + blur cleanup
// ✅ Full-banner 3D rotation for 2 seconds
// ✅ Dissolves into realistic dust (canvas particle sim) for 3 seconds
// ✅ Uses username from extension storage (mbx_username_config): newName if enabled else oldName
// ✅ Optimized to avoid freezing Miniblox (particle count adapts to device, FPS-safe loop, pausing on hidden tab)
// ✅ Cleans up after itself (DOM + canvas)
//
// NOTE: This is intentionally LONG and structured so you can keep expanding later.
//
// ──────────────────────────────────────────────────────────────────────────────
// 0) QUICK SETUP
// ──────────────────────────────────────────────────────────────────────────────
// In manifest.json content_scripts, ensure:
//   "js": ["content.js", "animations.js"]
//
// ──────────────────────────────────────────────────────────────────────────────
// 1) USER REQUEST TIMING
// ──────────────────────────────────────────────────────────────────────────────
// Appear: waits 10 seconds
// Zoom approach: ~1.9 seconds (realistic)
// Rotate: 2 seconds
// Dust dissolve: 3 seconds
//
// ──────────────────────────────────────────────────────────────────────────────
// 2) WHY THIS IS “MORE REALISTIC”
// ──────────────────────────────────────────────────────────────────────────────
// - requestAnimationFrame-driven transform interpolation (not only CSS) for better timing
// - blur and opacity ease-out cleanup on approach
// - subtle "camera settle" micro movement
// - true 3D spin (X + Y + Z), not only flat rotation
// - particle sim with drag, wind, turbulence, life curves
// - particle sampling from banner area (not only center)
// - pause/resume on visibilitychange to avoid waste/lag
//
// ──────────────────────────────────────────────────────────────────────────────
// 3) SAFE POLICY
// ──────────────────────────────────────────────────────────────────────────────
// This is a visual-only overlay. Does not modify server state or game logic.
//

(() => {
  "use strict";

  /* ============================================================================
     1) ONE-TIME GUARD
     ============================================================================ */
  const GUARD_KEY = "__MBX_ANIM_ULTRAGOD_V422__";
  if (window[GUARD_KEY]) return;
  window[GUARD_KEY] = true;

  /* ============================================================================
     2) STORAGE KEYS (same as content.js)
     ============================================================================ */
  const USER_CFG_KEY = "mbx_username_config";

  /* ============================================================================
     3) MASTER TIMELINE (requested)
     ============================================================================ */
  const TIMING = Object.freeze({
    APPEAR_DELAY_MS: 10000,  // wait 10s before showing anything
    ZOOM_IN_MS: 1900,        // approach duration
    SETTLE_MS: 260,          // micro settle duration
    ROTATE_MS: 2000,         // 2 seconds rotate
    DUST_MS: 3000,           // 3 seconds dust
    CLEANUP_PAD_MS: 220      // small pad to remove stuff cleanly
  });

  /* ============================================================================
     4) VISUAL CONSTANTS
     ============================================================================ */
  const UI = Object.freeze({
    Z_INDEX_BACKDROP: 2147483646,
    Z_INDEX_CANVAS: 2147483647,

    MAX_WIDTH_DESKTOP: 560,
    MAX_WIDTH_MOBILE: 340,

    BORDER_RADIUS_PX: 22,

    COLOR_PRIMARY: "#EAF2FF",
    COLOR_GOLD: "#FFD400",
    COLOR_AQUA: "#00FFBE",
    COLOR_BLUE: "#788CFF",

    BG_RGBA: "rgba(10, 12, 18, 0.72)",
    BORDER_RGBA: "rgba(255,255,255,0.16)",

    TEXT_SHADOW: "0 0 14px rgba(255,214,0,0.22), 0 0 22px rgba(0,255,190,0.14)",

    POINTER_EVENTS: "none"
  });

  /* ============================================================================
     5) PERFORMANCE TUNING
     ============================================================================ */
  const PERF = Object.freeze({
    DPR_CAP: 2,                 // cap device pixel ratio
    FPS_CAP: 60,                // soft cap (we still use RAF)
    MOBILE_BREAKPOINT: 520,

    // Particle budget:
    BASE_PARTICLES_DESKTOP: 260,
    BASE_PARTICLES_MOBILE: 160,

    // Dust physics:
    DRAG: 0.985,
    GRAVITY: -8,               // negative rises slightly
    TURBULENCE: 0.12,
    WIND_MIN: -18,
    WIND_MAX: 22,

    // Dust visuals:
    DUST_SIZE_MIN: 1.2,
    DUST_SIZE_MAX: 4.2,
    DUST_GLOW: 0.35
  });

  /* ============================================================================
     6) MATH / EASING UTILITIES
     ============================================================================ */
  const Mathx = {
    clamp(n, a, b) { return Math.max(a, Math.min(b, n)); },
    lerp(a, b, t) { return a + (b - a) * t; },
    rand(min, max) { return Math.random() * (max - min) + min; },

    // Easing (smooth & cinematic)
    easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); },
    easeInOutCubic(t) {
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },
    easeOutExpo(t) {
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }
  };

  /* ============================================================================
     7) ENV / SAFETY HELPERS
     ============================================================================ */
  const Env = {
    safeTrim(v) { return String(v ?? "").trim(); },

    isMobileLike() {
      return Math.min(window.innerWidth, window.innerHeight) <= PERF.MOBILE_BREAKPOINT;
    },

    prefersReducedMotion() {
      try {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch {
        return false;
      }
    },

    now() {
      return performance.now();
    },

    removeIfExists(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  };

  /* ============================================================================
     8) LOGGING (toggle)
     ============================================================================ */
  const LOG = Object.freeze({
    enabled: false,
    tag: "[mbx.anim]"
  });

  function log(...args) {
    if (!LOG.enabled) return;
    console.log(LOG.tag, ...args);
  }

  /* ============================================================================
     9) USERNAME RESOLUTION
     ============================================================================ */
  function getDisplayName(cfg) {
    const enabled = !!cfg?.enabled;
    const newName = Env.safeTrim(cfg?.newName);
    const oldName = Env.safeTrim(cfg?.oldName);
    if (enabled && newName) return newName;
    if (oldName) return oldName;
    return "Player";
  }

  /* ============================================================================
     10) CSS INJECTION (DOM overlay)
     ============================================================================ */
  function injectStylesOnce() {
    if (document.getElementById("mbxAnimStyles")) return;

    const style = document.createElement("style");
    style.id = "mbxAnimStyles";
    style.textContent = `
      /* ===========================================================
         MBX Ultra God Cinematic Overlay
         =========================================================== */

      #mbxCineBackdrop {
        position: fixed;
        inset: 0;
        z-index: ${UI.Z_INDEX_BACKDROP};
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: ${UI.POINTER_EVENTS};
        perspective: 1100px;
      }

      #mbxCineStage {
        position: relative;
        width: min(${UI.MAX_WIDTH_DESKTOP}px, 92vw);
        transform-style: preserve-3d;
        pointer-events: ${UI.POINTER_EVENTS};
      }

      @media (max-width: ${PERF.MOBILE_BREAKPOINT}px) {
        #mbxCineStage {
          width: min(${UI.MAX_WIDTH_MOBILE}px, 92vw);
        }
      }

      #mbxCineBanner {
        position: relative;
        border-radius: ${UI.BORDER_RADIUS_PX}px;
        padding: 20px 26px;

        background: ${UI.BG_RGBA};
        border: 1px solid ${UI.BORDER_RGBA};

        box-shadow:
          0 30px 80px rgba(0,0,0,0.60),
          inset 0 0 0 1px rgba(255,255,255,0.06);

        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);

        overflow: hidden;
        transform-style: preserve-3d;

        opacity: 0;
        transform:
          translateY(18px)
          translateZ(-620px)
          scale(0.10)
          rotateX(16deg);

        filter: blur(1.8px);
        will-change: transform, opacity, filter;
        pointer-events: ${UI.POINTER_EVENTS};
      }

      #mbxCineBanner::before {
        content: "";
        position: absolute;
        inset: -2px;
        border-radius: ${UI.BORDER_RADIUS_PX + 2}px;
        padding: 2px;

        background: conic-gradient(
          from 180deg,
          rgba(255,214,0,0),
          rgba(255,214,0,.95),
          rgba(0,255,190,.85),
          rgba(120,140,255,.85),
          rgba(255,214,0,.95),
          rgba(255,214,0,0)
        );

        mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        -webkit-mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);

        mask-composite: exclude;
        -webkit-mask-composite: xor;

        opacity: 0.85;
        animation: mbxRingSpin 2600ms linear infinite;
        pointer-events: ${UI.POINTER_EVENTS};
      }

      @keyframes mbxRingSpin {
        to { transform: rotate(360deg); }
      }

      #mbxNoise {
        position: absolute;
        inset: 0;
        opacity: 0.07;
        mix-blend-mode: overlay;
        pointer-events: ${UI.POINTER_EVENTS};

        background-image:
          repeating-linear-gradient(
            0deg,
            rgba(255,255,255,0.05),
            rgba(255,255,255,0.05) 1px,
            transparent 1px,
            transparent 2px
          );
      }

      #mbxTitleRow {
        display: flex;
        align-items: center;
        gap: 12px;
        pointer-events: ${UI.POINTER_EVENTS};
      }

      #mbxBadge {
        font: 900 12px system-ui;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.14);
        color: rgba(255,255,255,0.86);
        pointer-events: ${UI.POINTER_EVENTS};
      }

      #mbxName {
        font: 950 22px system-ui;
        letter-spacing: 0.02em;
        color: ${UI.COLOR_PRIMARY};
        text-shadow: ${UI.TEXT_SHADOW};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: ${UI.POINTER_EVENTS};
      }

      #mbxSub {
        margin-top: 10px;
        font: 800 12px system-ui;
        color: rgba(220,235,255,0.80);
        opacity: 0.92;
        pointer-events: ${UI.POINTER_EVENTS};
      }

      @media (max-width: ${PERF.MOBILE_BREAKPOINT}px) {
        #mbxName { font-size: 18px; }
      }

      #mbxDustCanvas {
        position: fixed;
        inset: 0;
        z-index: ${UI.Z_INDEX_CANVAS};
        pointer-events: ${UI.POINTER_EVENTS};
      }
    `;
    document.documentElement.appendChild(style);
  }

  /* ============================================================================
     11) DOM BUILDERS
     ============================================================================ */
  function buildOverlay(displayName) {
    Env.removeIfExists("mbxCineBackdrop");

    injectStylesOnce();

    const backdrop = document.createElement("div");
    backdrop.id = "mbxCineBackdrop";

    const stage = document.createElement("div");
    stage.id = "mbxCineStage";

    const banner = document.createElement("div");
    banner.id = "mbxCineBanner";

    const titleRow = document.createElement("div");
    titleRow.id = "mbxTitleRow";

    const badge = document.createElement("div");
    badge.id = "mbxBadge";
    badge.textContent = "WELCOME";

    const name = document.createElement("div");
    name.id = "mbxName";
    name.textContent = displayName;

    const sub = document.createElement("div");
    sub.id = "mbxSub";
    sub.textContent = "Miniblox loaded • Ultra cinematic overlay (visual-only)";

    const noise = document.createElement("div");
    noise.id = "mbxNoise";

    titleRow.append(badge, name);
    banner.append(titleRow, sub, noise);
    stage.appendChild(banner);
    backdrop.appendChild(stage);

    document.documentElement.appendChild(backdrop);

    return { backdrop, stage, banner };
  }

  /* ============================================================================
     12) RAF LOOP CONTROLLER (with pause on hidden tab)
     ============================================================================ */
  function createRafController() {
    const state = {
      running: false,
      paused: false,
      last: 0,
      rafId: 0,
      fn: null
    };

    function onVisibilityChange() {
      state.paused = document.hidden;
    }

    document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });

    function start(fn) {
      state.fn = fn;
      state.running = true;
      state.last = Env.now();

      const step = (now) => {
        if (!state.running) return;

        state.rafId = requestAnimationFrame(step);

        // Pause if tab hidden
        if (state.paused) {
          state.last = now;
          return;
        }

        const dt = now - state.last;
        state.last = now;
        state.fn(now, dt);
      };

      state.rafId = requestAnimationFrame(step);
      return () => stop();
    }

    function stop() {
      state.running = false;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }

    return { start, stop };
  }

  /* ============================================================================
     13) APPROACH ANIMATION (realistic)
     ============================================================================ */
  function animateApproach(banner) {
    return new Promise((resolve) => {
      const raf = createRafController();
      const t0 = Env.now();

      raf.start((now) => {
        const t = Mathx.clamp((now - t0) / TIMING.ZOOM_IN_MS, 0, 1);
        const e = Mathx.easeOutExpo(t);

        const z = Mathx.lerp(-620, 0, e);
        const s = Mathx.lerp(0.10, 1.0, e);
        const y = Mathx.lerp(18, 0, e);

        const blur = Mathx.lerp(1.8, 0.0, e);
        const rx = Mathx.lerp(16, 0, e);

        const op = Mathx.clamp(e * 1.2, 0, 1);

        banner.style.opacity = String(op);
        banner.style.filter = `blur(${blur.toFixed(2)}px)`;
        banner.style.transform =
          `translateY(${y.toFixed(2)}px) ` +
          `translateZ(${z.toFixed(2)}px) ` +
          `scale(${s.toFixed(4)}) ` +
          `rotateX(${rx.toFixed(2)}deg)`;

        if (t >= 1) {
          raf.stop();
          resolve();
        }
      });
    });
  }

  /* ============================================================================
     14) MICRO CAMERA SETTLE (tiny stabilization)
     ============================================================================ */
  function animateSettle(banner) {
    return new Promise((resolve) => {
      const raf = createRafController();
      const t0 = Env.now();

      raf.start((now) => {
        const t = Mathx.clamp((now - t0) / TIMING.SETTLE_MS, 0, 1);
        const e = Mathx.easeInOutCubic(t);

        const amp = (1 - e) * 2.2;
        const dx = Math.sin(now / 18) * amp;
        const dy = Math.cos(now / 22) * amp * 0.6;

        banner.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0px) scale(1)`;

        if (t >= 1) {
          raf.stop();
          banner.style.transform = "translate3d(0,0,0) scale(1)";
          resolve();
        }
      });
    });
  }

  /* ============================================================================
     15) ROTATION (true 3D spin)
     ============================================================================ */
  function animateRotate3D(banner) {
    return new Promise((resolve) => {
      const raf = createRafController();
      const t0 = Env.now();

      raf.start((now) => {
        const t = Mathx.clamp((now - t0) / TIMING.ROTATE_MS, 0, 1);
        const e = Mathx.easeInOutCubic(t);

        const ry = Mathx.lerp(0, 360, e);
        const rz = Mathx.lerp(0, 360, e);
        const rx = Math.sin(e * Math.PI) * 10;

        banner.style.transform =
          `translate3d(0,0,0) ` +
          `rotateX(${rx.toFixed(2)}deg) ` +
          `rotateY(${ry.toFixed(2)}deg) ` +
          `rotateZ(${rz.toFixed(2)}deg)`;

        if (t >= 1) {
          raf.stop();
          banner.style.transform = "translate3d(0,0,0)";
          resolve();
        }
      });
    });
  }

  /* ============================================================================
     16) CANVAS DUST SYSTEM (realistic particles)
     ============================================================================ */

  function createCanvasLayer() {
    Env.removeIfExists("mbxDustCanvas");

    const canvas = document.createElement("canvas");
    canvas.id = "mbxDustCanvas";
    document.documentElement.appendChild(canvas);

    const ctx = canvas.getContext("2d", { alpha: true });

    const dpr = Math.max(1, Math.min(PERF.DPR_CAP, window.devicePixelRatio || 1));

    function resize() {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";

      // scale drawing to CSS pixels
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });

    return { canvas, ctx, dpr, resize };
  }

  function pickDustColor() {
    const r = Math.random();
    if (r < 0.55) return UI.COLOR_GOLD;
    if (r < 0.80) return UI.COLOR_AQUA;
    return UI.COLOR_BLUE;
  }

  function computeParticleCount() {
    const mobile = Env.isMobileLike();
    let count = mobile ? PERF.BASE_PARTICLES_MOBILE : PERF.BASE_PARTICLES_DESKTOP;

    // If the device is very large, allow slightly more (but still safe)
    const area = window.innerWidth * window.innerHeight;
    if (!mobile && area > 1600 * 900) count += 40;

    // If reduced motion, fewer
    if (Env.prefersReducedMotion()) count = Math.round(count * 0.5);

    // Hard clamp
    count = Mathx.clamp(count, 90, 340);

    return count;
  }

  function buildParticlesFromRect(rect) {
    const count = computeParticleCount();
    const particles = [];

    // Pre-calc boundaries (avoid sampling too close to border)
    const left = rect.left + 10;
    const right = rect.right - 10;
    const top = rect.top + 10;
    const bottom = rect.bottom - 10;

    // If rect is too small (edge case), fallback to center
    const safeLeft = isFinite(left) ? left : window.innerWidth / 2;
    const safeRight = isFinite(right) ? right : window.innerWidth / 2 + 1;
    const safeTop = isFinite(top) ? top : window.innerHeight / 2;
    const safeBottom = isFinite(bottom) ? bottom : window.innerHeight / 2 + 1;

    for (let i = 0; i < count; i++) {
      // Sample emission point inside banner
      const x = Mathx.rand(safeLeft, safeRight);
      const y = Mathx.rand(safeTop, safeBottom);

      // Direction biased upward-ish
      const angle = Mathx.rand(-Math.PI * 0.15, Math.PI * 1.15);
      const speed = Mathx.rand(30, 180);

      const vx = Math.cos(angle) * speed + Mathx.rand(PERF.WIND_MIN, PERF.WIND_MAX);
      const vy = Math.sin(angle) * speed + Mathx.rand(-40, 40);

      const size = Mathx.rand(PERF.DUST_SIZE_MIN, PERF.DUST_SIZE_MAX);
      const color = pickDustColor();

      particles.push({
        x, y,
        vx, vy,
        size,
        color,
        seed: Math.random() * 9999,

        lifeMs: 0,
        maxLifeMs: Mathx.rand(TIMING.DUST_MS * 0.75, TIMING.DUST_MS * 1.05),

        alpha: 1
      });
    }

    return particles;
  }

  function drawParticle(ctx, p) {
    // Soft glow
    ctx.globalAlpha = p.alpha;

    if (PERF.DUST_GLOW > 0) {
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 14 * PERF.DUST_GLOW;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
  }

  function dissolveToDust(banner, backdrop) {
    return new Promise((resolve) => {
      const rect = banner.getBoundingClientRect();
      const { canvas, ctx } = createCanvasLayer();
      const particles = buildParticlesFromRect(rect);

      // Hide the banner quickly so dust dominates
      banner.style.opacity = "0";
      banner.style.filter = "blur(2px)";
      banner.style.transform = "scale(0.985)";

      // Remove DOM overlay so it doesn't cover dust
      setTimeout(() => {
        try { backdrop.remove(); } catch {}
      }, 180);

      const raf = createRafController();
      const t0 = Env.now();

      raf.start((now, dt) => {
        const elapsed = now - t0;
        const t = Mathx.clamp(elapsed / TIMING.DUST_MS, 0, 1);

        // Clear canvas in CSS pixel units
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

        // Global fade (stronger at end)
        const fade = 1 - Math.pow(t, 1.35);

        // Wind oscillation
        const wind = Mathx.lerp(PERF.WIND_MIN, PERF.WIND_MAX, (Math.sin(now / 650) + 1) / 2) * 0.35;

        // Convert dt to seconds-like factor
        const dtSec = Mathx.clamp(dt, 0, 40) * 0.001; // cap huge dt spikes

        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];

          // Update life
          p.lifeMs += dt;

          // Local life curve
          const lifeT = Mathx.clamp(p.lifeMs / p.maxLifeMs, 0, 1);

          // Turbulence wobble
          const wobble = Math.sin((now + p.seed) / 90) * PERF.TURBULENCE;

          // Velocity update
          p.vx = (p.vx + wind * 0.02 + wobble) * PERF.DRAG;
          p.vy = (p.vy + PERF.GRAVITY * 0.02 - wobble) * PERF.DRAG;

          // Position update
          p.x += p.vx * (dtSec * 60); // normalize for ~60fps
          p.y += p.vy * (dtSec * 60);

          // Fade
          const localFade = 1 - Math.pow(lifeT, 1.25);
          p.alpha = Mathx.clamp(localFade * fade, 0, 1);

          // Shrink slightly
          const shrink = 1 - lifeT * 0.35;
          const r = Math.max(0.6, p.size * shrink);

          // Draw
          const prev = p.size;
          p.size = r;
          if (p.alpha > 0.01) drawParticle(ctx, p);
          p.size = prev;
        }

        // End
        if (t >= 1) {
          raf.stop();
          try { canvas.remove(); } catch {}
          resolve();
        }
      });
    });
  }

  /* ============================================================================
     17) FULL SEQUENCE RUNNER
     ============================================================================ */
  async function runSequence(displayName) {
    // Reduced motion: show simple and remove
    if (Env.prefersReducedMotion()) {
      const { backdrop, banner } = buildOverlay(displayName);
      banner.style.opacity = "1";
      banner.style.filter = "none";
      banner.style.transform = "none";
      setTimeout(() => {
        try { backdrop.remove(); } catch {}
      }, 2500);
      return;
    }

    const { backdrop, banner } = buildOverlay(displayName);

    // Wait 1 frame so layout is stable
    await new Promise((r) => requestAnimationFrame(() => r()));

    log("Approach...");
    await animateApproach(banner);

    log("Settle...");
    await animateSettle(banner);

    log("Rotate...");
    await animateRotate3D(banner);

    log("Dust...");
    await dissolveToDust(banner, backdrop);

    // Final safety pad
    await new Promise((r) => setTimeout(r, TIMING.CLEANUP_PAD_MS));
  }

  /* ============================================================================
     18) STARTUP (delay + storage)
     ============================================================================ */
  function start() {
    setTimeout(() => {
      try {
        chrome.storage.local.get([USER_CFG_KEY], (data) => {
          const cfg = data?.[USER_CFG_KEY] || {};
          const name = getDisplayName(cfg);
          runSequence(name);
        });
      } catch (e) {
        // If storage fails, fallback
        runSequence("Player");
      }
    }, TIMING.APPEAR_DELAY_MS);
  }

  /* ============================================================================
     19) DOM READY HOOK
     ============================================================================ */
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  /* ============================================================================
     20) EXTRA “PRO” SECTIONS (for future versions)
     ============================================================================ */

  // ────────────────────────────────────────────────────────────────────────────
  // A) Future: Play-button detection (start animation only after joining game)
  // ────────────────────────────────────────────────────────────────────────────
  function _future_detectGameStartAndRun() {
    // Idea:
    // - Observe DOM for HUD element that appears only once the game starts
    // - Then call runSequence()
    //
    // Example pseudo:
    // const obs = new MutationObserver(() => {
    //   if (document.querySelector(".hud") || document.querySelector("#inGameUI")) {
    //     obs.disconnect();
    //     runSequence(name);
    //   }
    // });
    // obs.observe(document.documentElement, {childList:true, subtree:true});
  }

  // ────────────────────────────────────────────────────────────────────────────
  // B) Future: Pixel dust (Minecraft vibe)
  // ────────────────────────────────────────────────────────────────────────────
  function _future_pixelDustRenderer(ctx, p) {
    // Instead of circles, draw small squares:
    // ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // C) Future: Light sweep highlight across the banner at arrival
  // ────────────────────────────────────────────────────────────────────────────
  function _future_lightSweep() {
    // Add pseudo-element / gradient sweep transform left->right
  }

  // ────────────────────────────────────────────────────────────────────────────
  // D) Future: Audio whoosh (WebAudio, optional/muted)
  // ────────────────────────────────────────────────────────────────────────────
  function _future_whooshSound() {
    // Generate a short filtered noise burst + pitch sweep.
  }

})();
