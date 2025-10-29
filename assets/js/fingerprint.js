// assets/js/fingerprint.js
import { mountMobileHeader, saveMe } from "./util.js";
import { connectWebSocket, sendWebSocketMessage, onWebSocketEvent } from "./api.js";
import { clearExecuteContext } from "./execute_context.js";

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
  const lockdownMode = sessionStorage.getItem(LOCKDOWN_SESSION_FLAG) === "1";
  const cleanupFns = [];
  let pendingLockdownRelease = false;
  const lockdownBanner = document.querySelector('[data-role="lockdown-banner"]');

  await mountMobileHeader({ title: "사용자 지문 인증", pageType: "login", backTo: "#/" });
  const stage = createFingerprintStage({ fallbackName: "사용자" });

  connectWebSocket(SITE);
  if (lockdownMode) {
    document.body.classList.add("lockdown-mode");
    cleanupFns.push(() => document.body.classList.remove("lockdown-mode"));
    sendWebSocketMessage({ type: "LOCKDOWN_STATUS_REQUEST", site: SITE });
  }

  const sendStart = () => {
    sendWebSocketMessage({ type: "FP_START_REQUEST", site: SITE, led: DEFAULT_LED_ON_COMMAND });
  };

  const stopSession = (reason) => {
    sendWebSocketMessage({ type: "FP_STOP_REQUEST", site: SITE, reason, turnOffLed: true });
  };

  let redirectTimer = null;
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
  const sessionHandlers = [
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
      setTimeout(() => { sendStart(); }, 3000);
    })
  ];
  if (lockdownMode) {
    const offLockdownStatus = onWebSocketEvent("LOCKDOWN_STATUS", (message) => {
      if (message?.site && message.site !== SITE) return;
      if (!pendingLockdownRelease) return;
      if (!isLockdownClearedMessage(message)) return;
      pendingLockdownRelease = false;
      sessionStorage.removeItem(LOCKDOWN_SESSION_FLAG);
      try { clearExecuteContext(); } catch (err) { console.warn("[AAMS][fp-user] 실행 컨텍스트 정리 실패", err); }
      cleanupFns.forEach((fn) => { try { fn(); } catch (_) {} });
      cleanupFns.length = 0;
      if (lockdownBanner) {
        lockdownBanner.hidden = false;
        lockdownBanner.textContent = "락다운이 해제되었습니다. 사용자 지문 인증 화면으로 이동합니다.";
      }
      window.onbeforeunload = null;
      location.hash = "#/fp-user";
    });
    sessionHandlers.push(offLockdownStatus);
  }

  const claimResult = await claimOnce({ redirect: "#/user", autoRedirect: false, onResolved: handleResolved });
  if (claimResult.success) {
    stopSession("claim-success");
    sessionHandlers.forEach((off) => { try { off(); } catch (_) {} });
    return;
  }

  const subscription = listenAndRedirect({ redirect: "#/user", autoRedirect: false, onResolved: handleResolved });

  const handleUnload = () => {
    subscription?.close?.();
    sessionHandlers.forEach((off) => { try { off(); } catch (_) {} });
    cleanupFns.forEach((fn) => { try { fn(); } catch (_) {} });
    if (redirectTimer) clearTimeout(redirectTimer);
    stopSession("navigation");
    if (lockdownMode) {
      sessionStorage.removeItem(LOCKDOWN_SESSION_FLAG);
    }
  };
  window.addEventListener("beforeunload", handleUnload, { once: true });
  window.addEventListener("pagehide", handleUnload, { once: true });

  sendStart();
}

export async function initFpAdmin() {
  const lockdownMode = sessionStorage.getItem(LOCKDOWN_SESSION_FLAG) === "1";
  await mountMobileHeader({ title: "관리자 지문 인증", pageType: "login", backTo: lockdownMode ? "#/fp-admin" : "#/admin-login" });
  const cleanupFns = [];
  const stage = createFingerprintStage({ fallbackName: "관리자" });
  const lockdownBanner = document.querySelector('[data-role="lockdown-banner"]');
  if (lockdownMode) {
    document.body.classList.add("lockdown-mode");
    cleanupFns.push(() => document.body.classList.remove("lockdown-mode"));
    if (lockdownBanner) {
      lockdownBanner.hidden = false;
      lockdownBanner.textContent = "락다운 해제를 위한 관리자 지문 인증입니다.";
    }
    const hideHeaderBtn = (id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    };
    ["m-back", "m-refresh", "m-logout", "m-home"].forEach(hideHeaderBtn);
    const preventNav = (event) => {
      if (location.hash !== "#/fp-admin") {
        event?.preventDefault?.();
        location.hash = "#/fp-admin";
      }
    };
    window.addEventListener("hashchange", preventNav, true);
    cleanupFns.push(() => window.removeEventListener("hashchange", preventNav, true));
    const unloadGuard = () => "락다운 해제 절차가 완료될 때까지 페이지를 이탈할 수 없습니다.";
    window.onbeforeunload = unloadGuard;
    cleanupFns.push(() => {
      if (window.onbeforeunload === unloadGuard) {
        window.onbeforeunload = null;
      }
    });
  } else if (lockdownBanner) {
    lockdownBanner.hidden = true;
  }
  const loginId = String(sessionStorage.getItem("AAMS_ADMIN_LOGIN_ID") || "").trim();
  let pendingLockdownRelease = false;
  const mismatchMessage = loginId
    ? `현재 로그인한 관리자 계정(${loginId})과 지문이 일치하지 않습니다. 다시 시도해 주세요.`
    : "로그인한 관리자 계정과 지문이 일치하지 않습니다. 다시 시도해 주세요.";

  const unauthorizedMessage = "등록된 관리자 지문이 아닙니다. 관리자 권한이 있는 지문으로 다시 시도해 주세요.";

  connectWebSocket(SITE);
  if (lockdownMode) {
    sendWebSocketMessage({ type: "LOCKDOWN_STATUS_REQUEST", site: SITE });
  }

  const sendStart = () => {
    sendWebSocketMessage({ type: "FP_START_REQUEST", site: SITE, led: DEFAULT_LED_ON_COMMAND });
  };

  const stopSession = (reason) => {
    sendWebSocketMessage({ type: "FP_STOP_REQUEST", site: SITE, reason, turnOffLed: true })
  };

  let redirectTimer = null;
  const scheduleRedirect = (target) => {
    const next = target || "#/admin";
    if (!next) return;
    if (redirectTimer) clearTimeout(redirectTimer);
    redirectTimer = setTimeout(() => { location.hash = next; }, WAIT_AFTER_SUCCESS_MS);
  };

  const handleResolved = async (me, ctx) => {
    const actualId = me?.user_id ? String(me.user_id).trim() : "";
    if (loginId && actualId && loginId !== actualId) {
      ctx.rejectReason = "login_mismatch";
      stage.showError(mismatchMessage, { autoResetMs: 2600 });
      sendStart()
      return false;
    }
    stage.setScanning();
    await sleep(SCAN_FEEDBACK_DELAY_MS);
    stage.showSuccess(me);
    stopSession("matched");
    if (lockdownMode) {
      pendingLockdownRelease = true;
      if (lockdownBanner) {
        lockdownBanner.hidden = false;
        lockdownBanner.textContent = "락다운 해제 요청을 전송했습니다. 잠시만 기다려 주세요.";
      }
      const actorPayload = {};
      if (me?.id) actorPayload.id = me.id;
      if (me?.name) actorPayload.name = me.name;
      if (me?.rank) actorPayload.rank = me.rank;
      sendWebSocketMessage({
        type: "LOCKDOWN_RELEASE",
        site: SITE,
        reason: "admin_unlock",
        actor: actorPayload
      });
      return true;
    }
    scheduleRedirect(ctx?.target || "#/admin");
    return true;
  };

  const handleRejected = async (info = {}) => {
    const reason = info.reason || "unknown";
    if (reason === "require_admin") {
      stage.showError(unauthorizedMessage, { autoResetMs: 5000 }); //경고 출력 및 재로그인 대기 시간
      sendStart()
      return;
    }
    if (reason === "login_mismatch") {
      return;
    }
    sendStart();
  };

  const sessionHandlers = [
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
      setTimeout(() => { sendStart(); }, 3000);
    })
  ];

  if (lockdownMode) {
    const offLockdownStatus = onWebSocketEvent("LOCKDOWN_STATUS", (message) => {
      if (message?.site && message.site !== SITE) return;
      if (!pendingLockdownRelease) return;
      if (!isLockdownClearedMessage(message)) return;
      pendingLockdownRelease = false;
      sessionStorage.removeItem(LOCKDOWN_SESSION_FLAG);
      try { clearExecuteContext(); } catch (err) { console.warn("[AAMS][fp-admin] 실행 컨텍스트 정리 실패", err); }
      if (lockdownBanner) {
        lockdownBanner.hidden = false;
        lockdownBanner.textContent = "락다운이 해제되었습니다. 사용자 지문 인증 화면으로 이동합니다.";
      }
      if (window.onbeforeunload) {
        window.onbeforeunload = null;
      }
      cleanupFns.forEach((fn) => { try { fn(); } catch (_) {} });
      cleanupFns.length = 0;
      scheduleRedirect("#/fp-user");
    });
    sessionHandlers.push(offLockdownStatus);
  }

  const claimResult = await claimOnceAdmin({ autoRedirect: false, onResolved: handleResolved });
  if (claimResult.success) {
    stopSession("claim-success");
    sessionHandlers.forEach((off) => { try { off(); } catch (_) {} });
    return;
  }

  if (claimResult.reason === "require_admin") {
    await handleRejected({ reason: "require_admin", source: "claim" });
  } else if (claimResult.reason === "callback_rejected") {
    await handleRejected({
      reason: claimResult.context?.rejectReason || "callback_rejected",
      source: "claim",
      context: claimResult.context,
      me: claimResult.me
    });
  } else if (claimResult.reason) {
    await handleRejected({ reason: claimResult.reason, source: "claim" });
  }

  const subscription = listenAndRedirect({
    requireAdmin: true,
    redirect: "#/admin",
    autoRedirect: false,
    onResolved: handleResolved,
    onRejected: handleRejected
  });

  const handleUnload = () => {
    subscription?.close?.();
    sessionHandlers.forEach((off) => { try { off(); } catch (_) {} });
    if (redirectTimer) clearTimeout(redirectTimer);
    stopSession("navigation");
  };
  window.addEventListener("beforeunload", handleUnload, { once: true });
  window.addEventListener("pagehide", handleUnload, { once: true });

  sendStart();
}