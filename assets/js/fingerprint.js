// assets/js/fingerprint.js
import { mountMobileHeader, saveMe, getFpLocalBase } from "./util.js";
import { openFpEventSource } from "./api.js";

const API_BASE = (window.AAMS_CONFIG && window.AAMS_CONFIG.API_BASE) || "";
const SITE = window.FP_SITE || "site-01";
const WAIT_AFTER_SUCCESS_MS = 2000;
const SCAN_FEEDBACK_DELAY_MS = 420;
const LOCAL_IDENTIFY_TIMEOUT_MS = 65000;
const DEFAULT_LED_ON_COMMAND = { mode: "breathing", color: "blue", speed: 18 };
const LED_OFF_COMMAND = { mode: "off" };

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function joinLocalUrl(base, path) {
  const trimmed = (base || "").trim();
  if (!trimmed) return path;
  return trimmed.replace(/\/?$/, "") + path;
}

function createLocalIdentifySession({ timeoutMs = LOCAL_IDENTIFY_TIMEOUT_MS } = {}) {
  const base = getFpLocalBase();
  if (!base) return null;

  const effectiveTimeout = Math.max(5000, Number(timeoutMs) || LOCAL_IDENTIFY_TIMEOUT_MS);
  const payload = {
    site: SITE,
    timeoutMs: effectiveTimeout,
    led: DEFAULT_LED_ON_COMMAND
  };

  const startUrl = joinLocalUrl(base, "/identify/start");
  const stopUrl = joinLocalUrl(base, "/identify/stop");

  let stopped = false;
  const listeners = [];
  const addListener = (type, handler, options) => {
    window.addEventListener(type, handler, options);
    listeners.push({ type, handler, options });
  };
  const cleanup = () => {
    while (listeners.length) {
      const { type, handler, options } = listeners.pop();
      window.removeEventListener(type, handler, options);
    }
  };

  const stop = async ({ reason = "manual", turnOffLed = true } = {}) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    try {
      const body = { site: SITE, reason };
      if (turnOffLed) {
        body.led = LED_OFF_COMMAND;
      }
      await fetch(stopUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).catch(() => {});
    } catch (err) {
      console.warn("[AAMS][fp] 로컬 지문 세션 종료 실패", err);
    }
  };

  const autoStop = () => { stop({ reason: "navigation", turnOffLed: true }); };
  addListener("hashchange", autoStop);
  addListener("beforeunload", autoStop);
  addListener("pagehide", autoStop, { once: true });

  const started = (async () => {
    const res = await fetch(startUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      const message = data?.message || data?.error || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return data;
  })();

  started.catch(() => stop({ reason: "start_failed", turnOffLed: true }));

  return { stop, started };
}

async function stopLocalIdentifySession(session, { reason = "manual", turnOffLed = true } = {}) {
  if (!session || typeof session.stop !== "function") return;
  try {
    await session.stop({ reason, turnOffLed });
  } catch (error) {
    console.warn("[AAMS][fp] 로컬 세션 정리 중 오류", error);
  }
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
  let handled = false;
  const es = openFpEventSource({
    site: SITE,
    onEvent: async (payload) => {
      if (handled) return;
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
      try { es.close(); } catch {}
    }
  });
  window.addEventListener("beforeunload", () => { try { es.close(); } catch {} });
  return es;
}

async function claimOnceAdmin(options = {}) {
  const { redirect = "#/admin", ...rest } = options || {};
  return claimOnce({ adminOnly: true, requireAdmin: true, redirect, ...rest });
}

export async function initFpUser() {
  await mountMobileHeader({ title: "사용자 지문 인증", pageType: "login", backTo: "#/" });
  const stage = createFingerprintStage({ fallbackName: "사용자" });

  let localSession = createLocalIdentifySession();
  if (localSession?.started) {
    localSession.started.catch((err) => {
      console.warn("[AAMS][fp] 사용자 지문 세션 시작 실패", err);
      stage.showError("지문 센서를 준비할 수 없습니다. 연결 상태를 확인해 주세요.", { autoResetMs: 0 });
    });
  }

  const stopLocal = async (reason) => {
    if (!localSession) return;
    const current = localSession;
    localSession = null;
    await stopLocalIdentifySession(current, { reason });
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
    const stopPromise = stopLocal("matched");
    await sleep(SCAN_FEEDBACK_DELAY_MS);
    stage.showSuccess(me);
    await stopPromise;
    scheduleRedirect(ctx?.target || "#/user");
    return true;
  };



  const claimResult = await claimOnce({ redirect: "#/user", autoRedirect: false, onResolved: handleResolved });
  if (claimResult.success) {
    await stopLocal("claim-success");
    return;
  }

  listenAndRedirect({ redirect: "#/user", autoRedirect: false, onResolved: handleResolved });
}

export async function initFpAdmin() {
  await mountMobileHeader({ title: "관리자 지문 인증", pageType: "login", backTo: "#/admin-login" });
  const stage = createFingerprintStage({ fallbackName: "관리자" });
  const loginId = String(sessionStorage.getItem("AAMS_ADMIN_LOGIN_ID") || "").trim();
  const mismatchMessage = loginId
    ? `현재 로그인한 관리자 계정(${loginId})과 지문이 일치하지 않습니다. 다시 시도해 주세요.`
    : "로그인한 관리자 계정과 지문이 일치하지 않습니다. 다시 시도해 주세요.";

  const unauthorizedMessage = "등록된 관리자 지문이 아닙니다. 관리자 권한이 있는 지문으로 다시 시도해 주세요.";

  let localSession = null;

  const startLocal = () => {
    if (localSession) return localSession;
    const session = createLocalIdentifySession();
    localSession = session;
    if (session?.started) {
      session.started.catch((err) => {
        console.warn("[AAMS][fp] 관리자 지문 세션 시작 실패", err);
        if (localSession === session) {
          localSession = null;
        }
        stage.showError("지문 센서를 준비할 수 없습니다. 연결 상태를 확인해 주세요.", { autoResetMs: 0 });
      });
    }
    return session;
  };

  const stopLocal = async (reason) => {
    const current = localSession;
    localSession = null;
    if (!current) return;
    try {
      await stopLocalIdentifySession(current, { reason });
    } catch (err) {
      console.warn(`[AAMS][fp] 로컬 세션 종료 실패(${reason})`, err);
    }
  };

  const restartLocal = async (reason) => {
    const current = localSession;
    localSession = null;
    if (current) {
      try {
        await stopLocalIdentifySession(current, { reason, turnOffLed: true });
      } catch (err) {
        console.warn(`[AAMS][fp] 로컬 세션 재시작 실패(${reason})`, err);
      }
    }
    startLocal();
  };

  startLocal();

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
      await restartLocal("login_mismatch");
      return false;
    }
    stage.setScanning();
    const stopPromise = stopLocal("matched");
    await sleep(SCAN_FEEDBACK_DELAY_MS);
    stage.showSuccess(me);
    await stopPromise;
    scheduleRedirect(ctx?.target || "#/admin");
    return true;
  };

  const handleRejected = async (info = {}) => {
    const reason = info.reason || "unknown";
    if (reason === "require_admin") {
      stage.showError(unauthorizedMessage, { autoResetMs: 2600 });
      await restartLocal("require_admin");
      return;
    }
    if (reason === "login_mismatch") {
      return;
    }
    await restartLocal(reason || "retry");
  };

  const claimResult = await claimOnceAdmin({ autoRedirect: false, onResolved: handleResolved });
  if (claimResult.success) {
    await stopLocal("claim-success");
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

  listenAndRedirect({
    requireAdmin: true,
    redirect: "#/admin",
    autoRedirect: false,
    onResolved: handleResolved,
    onRejected: handleRejected
  });
}