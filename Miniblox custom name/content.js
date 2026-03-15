/* =====================================================================
   Miniblox Custom Tools - content.js
   Version: 5.2.0
   Features:
     - Visual-only Custom Username
     - Visual-only Text Color Rule (bold/glow)
     - Optional PFP (circle) + optional colored border
     - Click username/PFP -> open big PFP modal
     - Welcome animation system loader (module injection)
     - Performance: batching + queue + MutationObserver + idle scheduling
   ===================================================================== */

/* eslint-disable no-console */
(() => {
  "use strict";

  const EXT_NAMESPACE = "mbx";
  const USER_CFG_KEY = "mbx_username_config";
  const STYLE_CFG_KEY = "mbx_text_styles";

  const ANIMATION_TEXT_KEY = "mbx_animation_text";
  const ANIMATION_ENABLED_KEY = "mbx_animation_enabled";

  const WELCOME_DELAY_MS = 2500;

  const MAX_QUEUE_SIZE = 200;
  const TEXT_NODES_PER_BATCH = 120;
  const IDLE_TIMEOUT_MS = 350;

  const PFP_SIZE_PX = 24;
  const MODAL_IMG_SIZE_PX = 360;

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "CANVAS",
    "SVG",
    "VIDEO",
    "AUDIO",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "LINK",
    "META"
  ]);

  const HOT_ROOTS = [];

  let USER_CFG = {
    enabled: true,
    oldName: "",
    newName: "",
    pfpEnabled: false,
    pfpUrl: "",
    pfpBorderEnabled: false,
    pfpBorderColor: "#FFD400"
  };

  let STYLE_RULES = [];

  let ANIMATION_CFG = {
    enabled: true,
    text: "WELCOME BACK"
  };

  let welcomeShown = false;
  let animationModuleReady = false;
  let animationInjected = false;

  let nameRegex = null;
  let lastOldName = "";

  const queue = [];
  const queuedSet = new WeakSet();
  let drainScheduled = false;
  let observer = null;

  function warn(...args) {
    console.warn(`[${EXT_NAMESPACE}]`, ...args);
  }

  function safeTrim(v) {
    return String(v ?? "").trim();
  }

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isEditable(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || "").toUpperCase();
    return SKIP_TAGS.has(tag);
  }

  function normalizeHex(val, fallback = "#FFD400") {
    let v = String(val || "").trim();
    if (!v) return fallback;
    if (/^[0-9a-fA-F]{6}$/.test(v)) v = "#" + v;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return fallback;
    return v.toUpperCase();
  }

  function normalizeColor(val, fallback = "#FFD400") {
    let v = String(val || "").trim();
    if (!v) return fallback;
    if (/^[0-9a-fA-F]{6}$/.test(v)) v = "#" + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;

    const test = document.createElement("div");
    test.style.color = "";
    test.style.color = v;
    if (test.style.color) return v;

    return fallback;
  }

  function buildNameRegexIfNeeded() {
    const oldName = safeTrim(USER_CFG.oldName);
    if (!oldName) {
      nameRegex = null;
      lastOldName = "";
      return;
    }
    if (oldName === lastOldName && nameRegex) return;
    lastOldName = oldName;
    nameRegex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g");
  }

  function getDisplayNameForWelcome() {
    const newName = safeTrim(USER_CFG.newName);
    const oldName = safeTrim(USER_CFG.oldName);
    if (USER_CFG.enabled && newName) return newName;
    if (oldName) return oldName;
    return "Player";
  }

  function isHotRoot(el) {
    if (!el || el.nodeType !== 1) return false;
    for (const sel of HOT_ROOTS) {
      try {
        if (el.matches(sel) || el.closest(sel)) return true;
      } catch {}
    }
    return false;
  }

  function ensureStyleTag() {
    if (document.getElementById("mbxStyles")) return;

    const style = document.createElement("style");
    style.id = "mbxStyles";
    style.textContent = `
.mbx-styled { display: inline; }
.mbx-bold { font-weight: 900 !important; }
.mbx-glow { text-shadow: 0 0 6px rgba(255,255,255,.60), 0 0 14px rgba(255,255,255,.35); }

.mbx-namewrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.mbx-pfp {
  width: ${PFP_SIZE_PX}px;
  height: ${PFP_SIZE_PX}px;
  border-radius: 999px;
  object-fit: cover;
  vertical-align: middle;
  border: var(--mbx-pfp-border, 0px) solid var(--mbx-pfp-border-color, #FFD400);
  box-sizing: border-box;
}

.mbx-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.65);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.mbx-modal-card {
  background: rgba(20,24,32,.95);
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 18px;
  box-shadow: 0 18px 60px rgba(0,0,0,.55);
  padding: 14px;
  max-width: min(420px, 92vw);
}
.mbx-modal-img {
  width: min(${MODAL_IMG_SIZE_PX}px, 82vw);
  height: min(${MODAL_IMG_SIZE_PX}px, 82vw);
  border-radius: 999px;
  object-fit: cover;
  display: block;
}
.mbx-modal-name {
  margin-top: 10px;
  color: #eaf2ff;
  font: 900 14px system-ui;
  text-align: center;
  opacity: .95;
}
.mbx-modal-hint {
  margin-top: 6px;
  color: #b7c3d6;
  font: 700 12px system-ui;
  text-align: center;
  opacity: .75;
}
    `;
    document.documentElement.appendChild(style);
  }

  function closePfpModal() {
    const modal = document.getElementById("mbxPfpModal");
    if (modal) modal.remove();
    document.removeEventListener("keydown", onModalKeydown, true);
  }

  function onModalKeydown(e) {
    if (e.key === "Escape") closePfpModal();
  }

  function openPfpModal(imgUrl) {
    if (!imgUrl) return;
    ensureStyleTag();

    closePfpModal();

    const backdrop = document.createElement("div");
    backdrop.id = "mbxPfpModal";
    backdrop.className = "mbx-modal-backdrop";

    const card = document.createElement("div");
    card.className = "mbx-modal-card";

    const img = document.createElement("img");
    img.className = "mbx-modal-img";
    img.src = imgUrl;
    img.alt = "Profile picture";
    img.referrerPolicy = "no-referrer";

    const name = document.createElement("div");
    name.className = "mbx-modal-name";
    name.textContent = safeTrim(USER_CFG.newName) || safeTrim(USER_CFG.oldName) || "Profile";

    const hint = document.createElement("div");
    hint.className = "mbx-modal-hint";
    hint.textContent = "Click outside or press ESC to close";

    card.append(img, name, hint);
    backdrop.appendChild(card);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closePfpModal();
    });

    document.documentElement.appendChild(backdrop);
    document.addEventListener("keydown", onModalKeydown, true);
  }

  function injectAnimationModule() {
    if (animationInjected) return;
    animationInjected = true;

    const s = document.createElement("script");
    s.type = "module";
    s.src = chrome.runtime.getURL("animations.js");
    s.onload = () => {
      animationModuleReady = true;
      s.remove();
    };
    s.onerror = () => {
      animationModuleReady = false;
      warn("Failed to load animations module.");
      s.remove();
    };
    (document.head || document.documentElement).appendChild(s);
  }

  function tryRunWelcomeAnimation() {
    if (welcomeShown) return;
    if (!ANIMATION_CFG.enabled) return;
    if (!animationModuleReady) return;
    if (typeof window.__MBX_runCustomNameAnimation !== "function") return;

    welcomeShown = true;

    const text =
      safeTrim(ANIMATION_CFG.text) ||
      "WELCOME BACK";

    try {
      window.__MBX_runCustomNameAnimation(text);
    } catch (e) {
      warn("Animation start failed:", e);
    }
  }

  function scheduleWelcomeAnimation() {
    const schedule = () => {
      setTimeout(() => {
        const tryNow = () => {
          if (animationModuleReady && typeof window.__MBX_runCustomNameAnimation === "function") {
            tryRunWelcomeAnimation();
            return;
          }
          setTimeout(tryNow, 250);
        };
        tryNow();
      }, WELCOME_DELAY_MS);
    };

    if (document.readyState === "complete" || document.readyState === "interactive") {
      schedule();
    } else {
      window.addEventListener("DOMContentLoaded", schedule, { once: true });
    }
  }

  function clearInjectedAll() {
    document.querySelectorAll(".mbx-styled").forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(span.textContent || ""), span);
      parent.normalize?.();
    });

    document.querySelectorAll(".mbx-namewrap").forEach((wrap) => {
      const parent = wrap.parentNode;
      if (!parent) return;
      const oldText = wrap.getAttribute("data-mbx-oldfull") || wrap.getAttribute("data-mbx-old") || "";
      parent.replaceChild(document.createTextNode(oldText), wrap);
      parent.normalize?.();
    });

    document.querySelectorAll("[data-mbx-styledkeys]").forEach((el) => el.removeAttribute("data-mbx-styledkeys"));
    document.querySelectorAll("[data-mbx-name-applied]").forEach((el) => el.removeAttribute("data-mbx-name-applied"));

    closePfpModal();

    if (typeof window.__MBX_resetCustomNameAnimation === "function") {
      try {
        window.__MBX_resetCustomNameAnimation();
      } catch {}
    }

    welcomeShown = false;
  }

  function getSingleRule() {
    const r = STYLE_RULES?.[0];
    if (!r) return null;

    const needle = safeTrim(r.text);
    if (!needle) return null;
    if (r.enabled === false) return null;

    return {
      text: needle,
      color: normalizeColor(r.color),
      bold: !!r.bold,
      glow: !!r.glow,
      enabled: true
    };
  }

  function createStyledSpan(text, rule) {
    const span = document.createElement("span");
    span.className =
      "mbx-styled" +
      (rule.bold ? " mbx-bold" : "") +
      (rule.glow ? " mbx-glow" : "");
    span.style.setProperty("color", rule.color, "important");
    span.textContent = text;
    return span;
  }

  function wrapMatchesInTextNode(textNode, rule) {
    const v = textNode.nodeValue;
    if (!v) return false;

    const needle = rule.text;
    const idx = v.indexOf(needle);
    if (idx === -1) return false;

    const parent = textNode.parentElement;
    if (!parent) return false;

    if (parent.closest(".mbx-styled")) return false;

    const key = `|k:${needle}|`;
    const applied = parent.getAttribute("data-mbx-styledkeys") || "";
    if (applied.includes(key)) return false;

    ensureStyleTag();

    const frag = document.createDocumentFragment();
    let start = 0;
    let changed = false;

    while (true) {
      const i = v.indexOf(needle, start);
      if (i === -1) break;

      if (i > start) frag.appendChild(document.createTextNode(v.slice(start, i)));
      frag.appendChild(createStyledSpan(needle, rule));
      start = i + needle.length;
      changed = true;
    }

    if (!changed) return false;
    if (start < v.length) frag.appendChild(document.createTextNode(v.slice(start)));

    parent.setAttribute("data-mbx-styledkeys", applied + key);
    parent.insertBefore(frag, textNode);
    textNode.remove();
    return true;
  }

  function buildStyledNameFragment(nameText) {
    const rule = getSingleRule();
    if (!rule) return document.createTextNode(nameText);

    const v = String(nameText || "");
    if (!v.includes(rule.text)) return document.createTextNode(v);

    ensureStyleTag();

    const frag = document.createDocumentFragment();
    let start = 0;
    let changed = false;

    while (true) {
      const i = v.indexOf(rule.text, start);
      if (i === -1) break;

      if (i > start) frag.appendChild(document.createTextNode(v.slice(start, i)));
      frag.appendChild(createStyledSpan(rule.text, rule));

      start = i + rule.text.length;
      changed = true;
    }

    if (!changed) return document.createTextNode(v);
    if (start < v.length) frag.appendChild(document.createTextNode(v.slice(start)));

    return frag;
  }

  function createNameWrapper(oldMatchedText) {
    const wrap = document.createElement("span");
    wrap.className = "mbx-namewrap";
    wrap.setAttribute("data-mbx-old", oldMatchedText);
    wrap.setAttribute("data-mbx-oldfull", oldMatchedText);

    const usePfp = !!(USER_CFG.pfpEnabled && USER_CFG.pfpUrl);
    if (!usePfp) return null;

    const img = document.createElement("img");
    img.className = "mbx-pfp";
    img.src = USER_CFG.pfpUrl;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";

    const borderOn = !!USER_CFG.pfpBorderEnabled;
    const borderColor = normalizeHex(USER_CFG.pfpBorderColor || "#FFD400");
    img.style.setProperty("--mbx-pfp-border", borderOn ? "2px" : "0px");
    img.style.setProperty("--mbx-pfp-border-color", borderColor);

    const nameSpan = document.createElement("span");
    nameSpan.appendChild(buildStyledNameFragment(USER_CFG.newName));

    wrap.appendChild(img);
    wrap.appendChild(nameSpan);

    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      openPfpModal(USER_CFG.pfpUrl);
    });

    return wrap;
  }

  function replaceUsernameInTextNode(textNode) {
    if (!USER_CFG.enabled) return;
    if (!nameRegex) return;

    const newName = safeTrim(USER_CFG.newName);
    if (!newName) return;

    const parent = textNode.parentElement;
    if (!parent) return;

    if (parent.closest(".mbx-namewrap")) return;
    if (parent.getAttribute("data-mbx-name-applied") === "1") return;

    const v = textNode.nodeValue;
    if (!v) return;

    if (v.includes(newName)) {
      parent.setAttribute("data-mbx-name-applied", "1");
      return;
    }

    if (!nameRegex.test(v)) return;

    ensureStyleTag();

    const usePfp = !!(USER_CFG.pfpEnabled && USER_CFG.pfpUrl);

    if (!usePfp) {
      textNode.nodeValue = v.replace(nameRegex, newName);
      parent.setAttribute("data-mbx-name-applied", "1");
      return;
    }

    const frag = document.createDocumentFragment();
    let start = 0;
    const rx = new RegExp(nameRegex.source, "g");
    let m;
    let changed = false;

    while ((m = rx.exec(v))) {
      const idx = m.index;

      if (idx > start) frag.appendChild(document.createTextNode(v.slice(start, idx)));

      const wrapper = createNameWrapper(m[0]);
      if (wrapper) frag.appendChild(wrapper);
      else frag.appendChild(document.createTextNode(newName));

      start = idx + m[0].length;
      changed = true;
    }

    if (!changed) return;

    if (start < v.length) frag.appendChild(document.createTextNode(v.slice(start)));

    parent.setAttribute("data-mbx-name-applied", "1");
    parent.insertBefore(frag, textNode);
    textNode.remove();
  }

  function replaceInAttributes(el) {
    if (!el || el.nodeType !== 1) return;
    if (!USER_CFG.enabled) return;
    if (!nameRegex) return;

    const newName = safeTrim(USER_CFG.newName);
    if (!newName) return;

    const attrs = ["title", "aria-label", "alt"];
    for (const a of attrs) {
      const val = el.getAttribute?.(a);
      if (!val) continue;
      if (val.includes(newName)) continue;
      if (!nameRegex.test(val)) continue;
      try {
        el.setAttribute(a, val.replace(nameRegex, newName));
      } catch {}
    }
  }

  function enqueue(node) {
    if (!node) return;
    if (queue.length >= MAX_QUEUE_SIZE) return;
    if (queuedSet.has(node)) return;

    queuedSet.add(node);
    queue.push(node);
    scheduleDrain();
  }

  function scheduleDrain() {
    if (drainScheduled) return;
    drainScheduled = true;

    const runner = () => {
      drainScheduled = false;
      drainQueue();
    };

    if ("requestIdleCallback" in window) {
      requestIdleCallback(runner, { timeout: IDLE_TIMEOUT_MS });
    } else {
      setTimeout(runner, 25);
    }
  }

  function drainQueue() {
    let processedTextNodes = 0;

    while (queue.length && processedTextNodes < TEXT_NODES_PER_BATCH) {
      const node = queue.shift();
      queuedSet.delete(node);

      if (!node) continue;
      if (node.nodeType === 1 && !node.isConnected) continue;
      if (node.nodeType === 3 && !node.isConnected) continue;
      if (node.nodeType === 1 && isHotRoot(node)) continue;

      if (node.nodeType === 3) {
        processTextNode(node);
        processedTextNodes++;
        continue;
      }

      if (node.nodeType === 1) {
        processElement(node, () => {
          processedTextNodes++;
        });
      }
    }

    if (queue.length) scheduleDrain();
  }

  function processTextNode(textNode) {
    if (!textNode || textNode.nodeType !== 3) return;
    if (isEditable(textNode)) return;

    const parent = textNode.parentElement;
    if (!parent) return;

    if (shouldSkipElement(parent)) return;
    if (parent.closest(".mbx-styled")) return;

    buildNameRegexIfNeeded();

    if (nameRegex) replaceUsernameInTextNode(textNode);

    const rule = getSingleRule();
    if (rule && textNode.isConnected) {
      wrapMatchesInTextNode(textNode, rule);
    }
  }

  function processElement(el, onTextProcessed) {
    if (!el || el.nodeType !== 1) return;
    if (shouldSkipElement(el)) return;
    if (isEditable(el)) return;

    buildNameRegexIfNeeded();
    if (nameRegex) replaceInAttributes(el);

    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (t) => {
          const p = t.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (isEditable(t)) return NodeFilter.FILTER_REJECT;
          if (shouldSkipElement(p)) return NodeFilter.FILTER_REJECT;
          if (p.closest(".mbx-namewrap")) return NodeFilter.FILTER_REJECT;
          if (p.closest(".mbx-styled")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let t;
    while ((t = walker.nextNode())) {
      processTextNode(t);
      if (typeof onTextProcessed === "function") onTextProcessed();
      if (queue.length > MAX_QUEUE_SIZE - 20) break;
    }
  }

  function initialScan() {
    const root = document.body || document.documentElement;
    enqueue(root);
  }

  function startObserver() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          m.addedNodes?.forEach((n) => {
            if (n?.nodeType === 1) {
              if (n.classList?.contains("mbx-namewrap")) return;
              if (n.classList?.contains("mbx-styled")) return;
            }
            enqueue(n);
          });
        } else if (m.type === "attributes") {
          const target = m.target;
          if (target?.nodeType === 1) enqueue(target);
        }
      }
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "alt"]
    });
  }

  function loadConfigAndStart() {
    try {
      chrome.storage.local.get(
        [USER_CFG_KEY, STYLE_CFG_KEY, ANIMATION_TEXT_KEY, ANIMATION_ENABLED_KEY],
        (data) => {
          USER_CFG = data[USER_CFG_KEY] || USER_CFG;
          STYLE_RULES = Array.isArray(data[STYLE_CFG_KEY]) ? data[STYLE_CFG_KEY] : [];

          ANIMATION_CFG = {
            enabled: data[ANIMATION_ENABLED_KEY] !== false,
            text: safeTrim(data[ANIMATION_TEXT_KEY]) || "WELCOME BACK"
          };

          ensureStyleTag();
          injectAnimationModule();
          scheduleWelcomeAnimation();
          startObserver();
          setTimeout(initialScan, 300);
        }
      );
    } catch (e) {
      warn("Failed to load config:", e);
      ensureStyleTag();
      injectAnimationModule();
      scheduleWelcomeAnimation();
      startObserver();
      setTimeout(initialScan, 300);
    }
  }

  function onStorageChanged(changes) {
    let shouldRescan = false;

    if (changes[USER_CFG_KEY]) {
      const newVal = changes[USER_CFG_KEY].newValue;

      if (!newVal) {
        clearInjectedAll();
        USER_CFG = {
          enabled: true,
          oldName: "",
          newName: "",
          pfpEnabled: false,
          pfpUrl: "",
          pfpBorderEnabled: false,
          pfpBorderColor: "#FFD400"
        };
      } else {
        USER_CFG = newVal;
      }

      nameRegex = null;
      lastOldName = "";
      shouldRescan = true;
    }

    if (changes[STYLE_CFG_KEY]) {
      const newRules = changes[STYLE_CFG_KEY].newValue;
      STYLE_RULES = Array.isArray(newRules) ? newRules : [];
      shouldRescan = true;
    }

    if (changes[ANIMATION_TEXT_KEY]) {
      ANIMATION_CFG.text = safeTrim(changes[ANIMATION_TEXT_KEY].newValue) || "WELCOME BACK";
    }

    if (changes[ANIMATION_ENABLED_KEY]) {
      ANIMATION_CFG.enabled = changes[ANIMATION_ENABLED_KEY].newValue !== false;
    }

    if (shouldRescan) {
      enqueue(document.body || document.documentElement);
    }
  }

  function boot() {
    if (!document.documentElement) {
      setTimeout(boot, 50);
      return;
    }

    loadConfigAndStart();

    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {
      warn("storage.onChanged not available:", e);
    }
  }

  function installGlobalCloseHooks() {
    document.addEventListener("click", () => {}, true);
  }

  boot();
  installGlobalCloseHooks();
})();