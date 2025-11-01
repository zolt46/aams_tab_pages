// assets/js/fingerprint.js
import { mountMobileHeader, saveMe } from "./util.js";
import { connectWebSocket, sendWebSocketMessage, onWebSocketEvent } from "./api.js";

const API_BASE = (window.AAMS_CONFIG && window.AAMS_CONFIG.API_BASE) || "";
const SITE = window.FP_SITE || "site-01";
const WAIT_AFTER_SUCCESS_MS = 2000;
const SCAN_FEEDBACK_DELAY_MS = 420;
const DEFAULT_LED_ON_COMMAND = { mode: "breathing", color: "blue", speed: 18 };

const SUCCESS_STOP_REASONS = new Set(["matched", "claim-success"]);
const LOCKDOWN_SESSION_FLAG = "AAMS_LOCKDOWN_MODE";

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeLockdownActive = (value) => !(value === false || value === "false" || value === 0 || value === "0");

function isLockdownClearedMessage(message = {}) {
  if (message == null || typeof message !== "object") return false;
  if (!normalizeLockdownActive(message.active)) return true;
  if (message.cleared === true || message.cleared === "true") return true;
  return false;
}

function extractSessionReason(message) {
  if (!message || typeof message !== "object") return "";
  const session = message.session || message.payload?.session || null;
  const reason = session?.reason || message.reason;
  return typeof reason === "string" ? reason.trim() : "";
}

function formatDisplayName(me = {}, fallback = "사용자") {
  const rank = me?.rank ? String(me.rank).trim() : "";
  const name = me?.name ? String(me.name).trim() : String(fallback);
  return [rank, name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function formatProfileSub(me = {}) {
  const unit = me.unit || me.unit_name;
  const position = me.position || me.duty;
  const serial = me.serial || me.military_id || me.militaryId || me.service_no;
  return [unit, position, serial]
    .map((value) => (value == null ? "" : String(value).trim()))
    .filter(Boolean)
    .join(" · ");
}

function pickTarget(result, fallback) {
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  if (result && typeof result === "object" && typeof result.target === "string" && result.target.trim()) {
    return result.target.trim();
  }
  return fallback;
}

function createFingerprintStage({ fallbackName = "사용자", errorResetMs = 2600 } = {}) {
  const stage = document.querySelector(".fp-stage");
  if (!stage) {
    return {
      setWaiting() {},
      setScanning() {},
      showSuccess() {},
      showError() {},
    };
  }

  const nameEl = stage.querySelector("[data-role='name']");
  const profileEl = stage.querySelector("[data-role='profile']");
  const profileNameEl = stage.querySelector("[data-role='profile-name']");
  const profileSubEl = stage.querySelector("[data-role='profile-sub']");
  const errorLine = stage.querySelector(".fp-status-line[data-for~='error']");
  const defaultError = errorLine ? errorLine.textContent.trim() : "";

  let resetTimer = null;
  const clearReset = () => { if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; } };

  const applyState = (state) => {
    stage.dataset.state = state;
    if (!profileEl) return;
    const hasDetail = !!(profileNameEl?.textContent || profileSubEl?.textContent);
    profileEl.hidden = !(state === "success" && hasDetail);
  };

  const setWaiting = () => {
    clearReset();
    if (errorLine) errorLine.textContent = defaultError;
    if (profileNameEl) profileNameEl.textContent = "";
    if (profileSubEl) profileSubEl.textContent = "";
    applyState("waiting");
  };

  const setScanning = () => {
    clearReset();
    if (profileEl) profileEl.hidden = true;
    applyState("scanning");
  };

  const showSuccess = (me = {}) => {
    clearReset();
    const displayName = formatDisplayName(me, fallbackName);
    if (nameEl) nameEl.textContent = displayName;
    if (profileNameEl) profileNameEl.textContent = displayName;
    if (profileSubEl) profileSubEl.textContent = formatProfileSub(me);
    if (errorLine) errorLine.textContent = defaultError;
    applyState("success");
  };

  const showError = (message, { autoResetMs = errorResetMs } = {}) => {
    clearReset();
    if (errorLine) errorLine.textContent = message || defaultError;
    if (profileEl) profileEl.hidden = true;
    applyState("error");
    if (autoResetMs && autoResetMs > 0) {
      resetTimer = setTimeout(() => {
        if (errorLine) errorLine.textContent = defaultError;
        applyState("waiting");
      }, autoResetMs);
    }
  };

  setWaiting();

  return { setWaiting, setScanning, showSuccess, showError };
}

async function enrichAndSave(me) {
  try {
    const r = await fetch(`${API_BASE}/api/personnel/${encodeURIComponent(me.id)}`);
    const detail = r.ok ? await r.json() : null;

    const mergedDetail = detail || {};
    const { is_admin: detailIsAdmin, ...restDetail } = mergedDetail;
    const merged = { ...me, ...restDetail };
    if (typeof me?.is_admin === "boolean") {
      merged.is_admin = me.is_admin || !!detailIsAdmin || !!merged.is_admin;
    } else if (detailIsAdmin !== undefined) {
      merged.is_admin = !!detailIsAdmin;
    }
    saveMe(merged);
    return merged;
  } catch {
    saveMe(me);
    return me;
  }
}

function resolveRedirect(me, redirect) {
  if (typeof redirect === "function") {
    try {
      return redirect(me);
    } catch {
      return null;
    }
  }
  if (typeof redirect === "string" && redirect.trim()) {
    return redirect;
  }
  return me?.is_admin ? "#/admin" : "#/user";
}


async function claimOnce({ adminOnly = false, requireAdmin = false, redirect, autoRedirect = true, onResolved } = {}) {
  try {
    const after = Number(localStorage.getItem("AAMS_LOGOUT_AT") || 0);
    const body = { site: SITE, after };
    if (adminOnly) body.adminOnly = true;
    const r = await fetch(`${API_BASE}/api/fp/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j && j.ok && j.person_id) {
      const base = { id: Number(j.person_id), name: j.name, is_admin: !!j.is_admin };
      if (requireAdmin && !base.is_admin) {
        return { success: false, reason: "require_admin", me: base };
      }
      const me = await enrichAndSave(base);
      const resolvedTarget = resolveRedirect(me, redirect);
      const ctx = { source: "claim", target: resolvedTarget };
      let cbResult;
      if (typeof onResolved === "function") {
        try {
          cbResult = await onResolved(me, ctx);
        } catch (err) {
          console.warn("[AAMS][fp] onResolved handler 오류", err);
        }
      }
      if (cbResult === false) {
        return {
          success: false,
          me,
          target: resolvedTarget,
          reason: ctx?.rejectReason || "callback_rejected",
          context: ctx
        };
      }
      const nextTarget = pickTarget(cbResult, resolvedTarget);
      if (autoRedirect !== false && nextTarget) {
        location.hash = nextTarget;
      }
      return { success: true, me, target: nextTarget };
    }
  } catch (err) {
    console.warn("[AAMS][fp] claimOnce 처리 중 오류", err);
    return { success: false, reason: "error", error: err };
  }
  return { success: false };
}

function listenAndRedirect({ requireAdmin = false, redirect, autoRedirect = true, onResolved, onRejected } = {}) {
  connectWebSocket(SITE);
  let handled = false;
  const unsubscribe = onWebSocketEvent("FP_EVENT", async (message) => {
    if (handled) return;
    if (message?.site && message.site !== SITE) return;
    const payload = message?.payload ?? message;
    const d = payload?.data;
    const r = payload?.resolved;
    if (!(d && d.type === "identify" && d.ok && r && r.person_id)) return;
    const base = { id: Number(r.person_id), name: r.name, is_admin: !!r.is_admin };
    if (requireAdmin && !base.is_admin) {
      if (typeof onRejected === "function") {
        try {
          await onRejected({ reason: "require_admin", base, payload, source: "event" });
        } catch (err) {
          console.warn("[AAMS][fp] onRejected 처리 중 오류", err);
        }
      }
      return;
    }
    const me = await enrichAndSave(base);
    const resolvedTarget = resolveRedirect(me, redirect);
    const ctx = { source: "event", event: payload, target: resolvedTarget };
    let cbResult;
    if (typeof onResolved === "function") {
      try {
        cbResult = await onResolved(me, ctx);
      } catch (err) {
        console.warn("[AAMS][fp] onResolved handler 오류", err);
      }
    }
    if (cbResult === false) {
      if (typeof onRejected === "function") {
        try {
          await onRejected({
            reason: ctx?.rejectReason || "callback_rejected",
            me,
            ctx,
            payload,
            source: "event"
          });
        } catch (err) {
          console.warn("[AAMS][fp] onRejected 처리 중 오류", err);
        }
      }
      return;
    }
    if (handled) return;
    handled = true;
    const nextTarget = pickTarget(cbResult, resolvedTarget);
    if (autoRedirect !== false && nextTarget) {
      location.hash = nextTarget;
    }
    try { unsubscribe(); } catch {}
  });

  const cleanup = () => {
    handled = true;
    try { unsubscribe(); } catch {}
  };

  window.addEventListener("beforeunload", cleanup, { once: true });
  return { close: cleanup };
}

async function claimOnceAdmin(options = {}) {
  const { redirect = "#/admin", ...rest } = options || {};
  return claimOnce({ adminOnly: true, requireAdmin: true, redirect, ...rest });
}

export async function initFpUser() {
  await mountMobileHeader({ title: "사용자 지문 인증", pageType: "login", backTo: "#/" });
  const stage = createFingerprintStage({ fallbackName: "사용자" });

  connectWebSocket(SITE);

  const sessionHandlers = [];
  let subscription = null;
  let redirectTimer = null;
  let cleanedUp = false;

  const sendStart = () => {
    if (cleanedUp) return;
    sendWebSocketMessage({ type: "FP_START_REQUEST", site: SITE, led: DEFAULT_LED_ON_COMMAND });
  };

  const stopSession = (reason) => {
    sendWebSocketMessage({ type: "FP_STOP_REQUEST", site: SITE, reason, turnOffLed: true });
  };

  const cleanup = (reason = "navigation") => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (redirectTimer) {
      clearTimeout(redirectTimer);
      redirectTimer = null;
    }
    subscription?.close?.();
    sessionHandlers.forEach((off) => { try { off(); } catch (_) {} });
    stopSession(reason);
  };

  const redirectToLockdown = () => {
    cleanup("lockdown");
    if (location.hash !== "#/lockdown") {
      try { location.hash = "#/lockdown"; }
      catch (err) { console.warn("[AAMS][fp-user] 락다운 페이지 이동 실패", err); }
    }
  };
  const handleLockdownStatus = (message) => {
    if (message?.site && message.site !== SITE) return;
    if (normalizeLockdownActive(message?.active)) {
      sessionStorage.setItem(LOCKDOWN_SESSION_FLAG, "1");
      redirectToLockdown();
    } else {
      sessionStorage.removeItem(LOCKDOWN_SESSION_FLAG);
    }
  };

  sessionHandlers.push(onWebSocketEvent("LOCKDOWN_STATUS", handleLockdownStatus));
  sendWebSocketMessage({ type: "LOCKDOWN_STATUS_REQUEST", site: SITE });

  if (sessionStorage.getItem(LOCKDOWN_SESSION_FLAG) === "1") {
    stopSession("lockdown");
    redirectToLockdown();
    return;
  }

  const scheduleRedirect = (target) => {
    const next = target || "#/user";
    if (!next) return;
    if (redirectTimer) clearTimeout(redirectTimer);
    redirectTimer = setTimeout(() => { location.hash = next; }, WAIT_AFTER_SUCCESS_MS);
  };

  const handleResolved = async (me, ctx) => {
    stage.setScanning();
    await sleep(SCAN_FEEDBACK_DELAY_MS);
    stage.showSuccess(me);
    stopSession("matched");
    scheduleRedirect(ctx?.target || "#/user");
    return true;
  };

  const handleRejected = async () => {
    sendStart();
  };

  sessionHandlers.push(
    onWebSocketEvent("FP_SESSION_STARTED", (message) => {
      if (message?.site && message.site !== SITE) return;
      stage.setScanning();
    }),
    onWebSocketEvent("FP_SESSION_STOPPED", (message) => {
      if (message?.site && message.site !== SITE) return;
      const reason = extractSessionReason(message);
      if (SUCCESS_STOP_REASONS.has(reason)) return;
      stage.setWaiting();
    }),
    onWebSocketEvent("FP_SESSION_ERROR", (message) => {
      if (message?.site && message.site !== SITE) return;
      const errorMessage = message?.error || "지문 센서를 준비할 수 없습니다. 연결 상태를 확인해 주세요.";
      stage.showError(errorMessage, { autoResetMs: 0 });
      setTimeout(() => { if (!cleanedUp) sendStart(); }, 3000);
    })
  );

  const claimResult = await claimOnce({ redirect: "#/user", autoRedirect: false, onResolved: handleResolved });
  if (claimResult.success) {
    stopSession("claim-success");
    sessionHandlers.forEach((off) => { try { off(); } catch (_) {} });
    return;
  }

  if (cleanedUp) {
    return;
  }

  subscription = listenAndRedirect({ redirect: "#/user", autoRedirect: false, onResolved: handleResolved, onRejected: handleRejected });

  const handleUnload = () => cleanup("navigation");
  window.addEventListener("beforeunload", handleUnload, { once: true });
  window.addEventListener("pagehide", handleUnload, { once: true });
  window.addEventListener("hashchange", handleUnload, { once: true });

  sendStart();
}

export async function initFpAdmin() {
  await mountMobileHeader({ title: "관리자 지문 안내", pageType: "login", backTo: "#/admin" });
  const stage = createFingerprintStage({ fallbackName: "관리자" });
  const banner = document.querySelector('[data-role="lockdown-banner"]');

  connectWebSocket(SITE);
  sendWebSocketMessage({ type: "FP_STOP_REQUEST", site: SITE, reason: "admin_fp_disabled", turnOffLed: true });

  if (banner) {
    banner.hidden = false;
    banner.textContent = "긴급 개방 해제는 관리자 PC에서만 진행됩니다. 관리자 화면으로 이동합니다.";
  }
  stage.showError("관리자 지문 인증 기능은 비활성화되었습니다.", { autoResetMs: 0 });

  const target = sessionStorage.getItem(LOCKDOWN_SESSION_FLAG) === "1" ? "#/lockdown" : "#/admin";
  setTimeout(() => {
    if (location.hash !== target) {
      try { location.hash = target; }
      catch (err) { console.warn("[AAMS][fp-admin] 이동 실패", err); }
    }
  }, 2000);
}
