const USER_CFG_KEY = "mbx_username_config";
const STYLE_CFG_KEY = "mbx_text_styles";
const DRAFT_KEY = "mbx_popup_draft_v2";

const uEnabled = document.getElementById("uEnabled");
const uOld = document.getElementById("uOld");
const uNew = document.getElementById("uNew");

const pEnabled = document.getElementById("pEnabled");
const pUrl = document.getElementById("pUrl");

const pBorderEnabled = document.getElementById("pBorderEnabled");
const pBorderColor = document.getElementById("pBorderColor");
const pBorderColorText = document.getElementById("pBorderColorText");

const rText = document.getElementById("rText");
const rColor = document.getElementById("rColor");
const rBold = document.getElementById("rBold");
const rGlow = document.getElementById("rGlow");

const saveAllBtn = document.getElementById("saveAll");
const clearAllBtn = document.getElementById("clearAll");
const applyLiveBtn = document.getElementById("applyLive");
const resetDraftBtn = document.getElementById("resetDraft");
const refreshPreviewBtn = document.getElementById("refreshPreview");

const statusEl = document.getElementById("saveStatus");
const previewNameEl = document.getElementById("previewName");
const previewOldEl = document.getElementById("previewOld");
const previewAvatarEl = document.getElementById("previewAvatar");
const domainChipEl = document.getElementById("domainChip");

let autosaveTimer = null;
let isHydrating = false;

function normalizeHex(val) {
  let v = String(val || "").trim();
  if (!v) return "#FFD400";
  if (/^[0-9a-fA-F]{6}$/.test(v)) v = "#" + v;
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) return "#FFD400";
  return v.toUpperCase();
}

function getDefaultState() {
  return {
    userCfg: {
      enabled: true,
      oldName: "",
      newName: "",
      pfpEnabled: false,
      pfpUrl: "",
      pfpBorderEnabled: false,
      pfpBorderColor: "#FFD400"
    },
    rules: []
  };
}

function setStatus(text, type = "idle") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.state = type;
}

function collectFormState() {
  return {
    userCfg: {
      enabled: !!uEnabled.checked,
      oldName: (uOld.value || "").trim(),
      newName: (uNew.value || "").trim(),
      pfpEnabled: !!pEnabled.checked,
      pfpUrl: (pUrl.value || "").trim(),
      pfpBorderEnabled: !!pBorderEnabled.checked,
      pfpBorderColor: normalizeHex(pBorderColorText.value || pBorderColor.value)
    },
    rules: (() => {
      const text = (rText.value || "").trim();
      if (!text) return [];
      return [{
        text,
        color: normalizeHex(rColor.value || "#FFD400"),
        bold: !!rBold.checked,
        glow: !!rGlow.checked,
        enabled: true
      }];
    })()
  };
}

function fillFormFromState(state) {
  const userCfg = state?.userCfg || {};
  const rules = Array.isArray(state?.rules) ? state.rules : [];

  uEnabled.checked = !!userCfg.enabled;
  uOld.value = userCfg.oldName || "";
  uNew.value = userCfg.newName || "";

  pEnabled.checked = !!userCfg.pfpEnabled;
  pUrl.value = userCfg.pfpUrl || "";

  pBorderEnabled.checked = !!userCfg.pfpBorderEnabled;

  const bc = normalizeHex(userCfg.pfpBorderColor || "#FFD400");
  pBorderColor.value = bc;
  pBorderColorText.value = bc;

  const r = rules[0] || {
    text: "",
    color: "#FFD400",
    bold: true,
    glow: true,
    enabled: true
  };

  rText.value = r.text || "";
  rColor.value = normalizeHex(r.color || "#FFD400");
  rBold.checked = !!r.bold;
  rGlow.checked = !!r.glow;
}

function updatePreview() {
  const oldName = (uOld.value || "").trim() || "OriginalName";
  const newName = (uNew.value || "").trim() || "[OWNER] OriginalName";
  const imageUrl = (pUrl.value || "").trim();
  const borderEnabled = !!pBorderEnabled.checked;
  const borderColor = normalizeHex(pBorderColorText.value || pBorderColor.value);

  previewNameEl.textContent = newName;
  previewOldEl.textContent = `Original: ${oldName}`;

  const styleColor = normalizeHex(rColor.value || "#FFD400");
  previewNameEl.style.color = styleColor;
  previewNameEl.style.fontWeight = rBold.checked ? "900" : "700";
  previewNameEl.style.textShadow = rGlow.checked
    ? `0 0 10px ${styleColor}55, 0 0 18px ${styleColor}33`
    : "none";

  if (pEnabled.checked && imageUrl) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = imageUrl;
    img.alt = "Preview avatar";
    img.onerror = () => {
      previewAvatarEl.className = "avatar placeholder";
      previewAvatarEl.textContent = "MB";
      previewAvatarEl.style.borderColor = borderEnabled ? borderColor : "rgba(255,255,255,.14)";
    };
    img.onload = () => {
      img.style.borderColor = borderEnabled ? borderColor : "rgba(255,255,255,.14)";
    };
    previewAvatarEl.replaceWith(img);
    img.id = "previewAvatar";
  } else {
    const box = document.createElement("div");
    box.id = "previewAvatar";
    box.className = "avatar placeholder";
    box.textContent = "MB";
    box.style.borderColor = borderEnabled ? borderColor : "rgba(255,255,255,.14)";
    previewAvatarEl.replaceWith(box);
  }
}

function saveDraftNow() {
  if (isHydrating) return;

  const state = collectFormState();
  setStatus("Saving draft...", "saving");

  chrome.storage.local.set(
    { [DRAFT_KEY]: { ...state, updatedAt: Date.now() } },
    () => {
      if (chrome.runtime.lastError) {
        setStatus("Draft save failed", "error");
        return;
      }
      setStatus("Draft saved automatically", "saved");
    }
  );
}

function scheduleAutosave() {
  if (isHydrating) return;

  updatePreview();
  setStatus("Unsaved changes", "dirty");

  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveDraftNow, 250);
}

function applyToExtension(closeAfter = false) {
  const state = collectFormState();
  setStatus("Applying...", "saving");

  chrome.storage.local.set(
    {
      [USER_CFG_KEY]: state.userCfg,
      [STYLE_CFG_KEY]: state.rules,
      [DRAFT_KEY]: { ...state, updatedAt: Date.now() }
    },
    () => {
      if (chrome.runtime.lastError) {
        setStatus("Apply failed", "error");
        return;
      }

      setStatus("Applied to game", "saved");

      if (closeAfter) {
        window.close();
      }
    }
  );
}

function clearAllData() {
  chrome.storage.local.remove(
    [USER_CFG_KEY, STYLE_CFG_KEY, DRAFT_KEY],
    () => {
      if (chrome.runtime.lastError) {
        setStatus("Clear failed", "error");
        return;
      }

      isHydrating = true;
      fillFormFromState(getDefaultState());
      isHydrating = false;

      updatePreview();
      setStatus("Everything cleared", "saved");
    }
  );
}

function resetDraftToSavedConfig() {
  chrome.storage.local.get([USER_CFG_KEY, STYLE_CFG_KEY], (data) => {
    const state = {
      userCfg: data[USER_CFG_KEY] || getDefaultState().userCfg,
      rules: Array.isArray(data[STYLE_CFG_KEY]) ? data[STYLE_CFG_KEY] : []
    };

    isHydrating = true;
    fillFormFromState(state);
    isHydrating = false;

    chrome.storage.local.set(
      { [DRAFT_KEY]: { ...state, updatedAt: Date.now() } },
      () => {
        if (chrome.runtime.lastError) {
          setStatus("Reset failed", "error");
          return;
        }
        updatePreview();
        setStatus("Draft reset to saved config", "saved");
      }
    );
  });
}

function detectActiveDomain() {
  if (!chrome.tabs || !chrome.tabs.query) {
    domainChipEl.textContent = "Popup mode";
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs?.[0]?.url || "";
    if (!url) {
      domainChipEl.textContent = "No active tab";
      return;
    }

    try {
      const host = new URL(url).hostname;
      domainChipEl.textContent = host;
    } catch {
      domainChipEl.textContent = "Unknown tab";
    }
  });
}

function load() {
  chrome.storage.local.get([USER_CFG_KEY, STYLE_CFG_KEY, DRAFT_KEY], (data) => {
    const savedState = {
      userCfg: data[USER_CFG_KEY] || getDefaultState().userCfg,
      rules: Array.isArray(data[STYLE_CFG_KEY]) ? data[STYLE_CFG_KEY] : []
    };

    const draftState = data[DRAFT_KEY];
    const stateToUse = draftState
      ? {
          userCfg: draftState.userCfg || savedState.userCfg,
          rules: Array.isArray(draftState.rules) ? draftState.rules : savedState.rules
        }
      : savedState;

    isHydrating = true;
    fillFormFromState(stateToUse);
    isHydrating = false;

    updatePreview();

    if (draftState) {
      setStatus("Draft restored", "saved");
    } else {
      setStatus("Ready", "idle");
    }
  });
}

pBorderColor.addEventListener("input", () => {
  pBorderColorText.value = pBorderColor.value.toUpperCase();
  scheduleAutosave();
});

pBorderColorText.addEventListener("input", () => {
  const n = normalizeHex(pBorderColorText.value);
  pBorderColor.value = n;
  scheduleAutosave();
});

[
  uEnabled, uOld, uNew,
  pEnabled, pUrl,
  pBorderEnabled,
  rText, rColor, rBold, rGlow
].forEach((el) => {
  el.addEventListener("input", scheduleAutosave);
  el.addEventListener("change", scheduleAutosave);
});

saveAllBtn.addEventListener("click", () => applyToExtension(true));
applyLiveBtn.addEventListener("click", () => applyToExtension(false));
clearAllBtn.addEventListener("click", clearAllData);
resetDraftBtn.addEventListener("click", resetDraftToSavedConfig);
refreshPreviewBtn.addEventListener("click", updatePreview);

window.addEventListener("beforeunload", () => {
  clearTimeout(autosaveTimer);
  saveDraftNow();
});

load();
detectActiveDomain();