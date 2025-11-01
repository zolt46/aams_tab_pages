import { mountMobileHeader } from "./util.js";
import { connectWebSocket, onWebSocketEvent, sendWebSocketMessage } from "./api.js";

const SITE = window.FP_SITE || "default";
const LOCKDOWN_SESSION_FLAG = "AAMS_LOCKDOWN_MODE";

let unsubscribes = [];
let guardHandler = null;

function setGuard(active) {
  if (active) {
    const handler = (event) => {
      if (location.hash !== "#/lockdown") {
        event?.preventDefault?.();
        location.hash = "#/lockdown";
      }
    };
    window.addEventListener("hashchange", handler, true);
    guardHandler = handler;
    window.onbeforeunload = () => "긴급 개방 프로토콜 해제 전에는 이탈할 수 없습니다.";
  } else {
    if (guardHandler) {
      window.removeEventListener("hashchange", guardHandler, true);
      guardHandler = null;
    }
    if (window.onbeforeunload) {
      window.onbeforeunload = null;
    }
  }
}

function updateDisplay(payload = {}) {
  const messageEl = document.getElementById("lockdownTabletMessage");
  const timeEl = document.getElementById("lockdownTabletTimestamp");
  const actorEl = document.getElementById("lockdownTabletActor");
  if (messageEl) {
    const text = payload.message || payload.reason || "총기함이 긴급 개방 상태로 전환되었습니다.";
    messageEl.textContent = text;
  }
  if (timeEl) {
    timeEl.textContent = payload.triggeredAt
      ? `발령 시각: ${new Date(payload.triggeredAt).toLocaleString('ko-KR')}`
      : "발령 시각: -";
  }
  if (actorEl) {
    const actor = payload.triggeredBy;
    if (actor?.name) {
      const rank = actor.rank ? `${actor.rank} ` : "";
      actorEl.textContent = `발령 담당: ${rank}${actor.name}`.trim();
    } else {
      actorEl.textContent = "발령 담당: -";
    }
  }
}

function handleStatus(message) {
  const active = !(message?.active === false);
  if (active) {
    sessionStorage.setItem(LOCKDOWN_SESSION_FLAG, "1");
    document.body.classList.add("lockdown-mode");
    sendWebSocketMessage({ type: "FP_STOP_REQUEST", site: SITE, reason: "lockdown", turnOffLed: true });
    updateDisplay(message || {});
    setGuard(true);
    if (location.hash !== "#/lockdown") {
      location.hash = "#/lockdown";
    }
  } else {
    sessionStorage.removeItem(LOCKDOWN_SESSION_FLAG);
    document.body.classList.remove("lockdown-mode");
    sendWebSocketMessage({ type: "FP_STOP_REQUEST", site: SITE, reason: "lockdown_cleared", turnOffLed: true });
    setGuard(false);
    unsubscribes.forEach((fn) => { try { fn(); } catch (_) {} });
    unsubscribes = [];
    if (location.hash === "#/lockdown") {
      location.hash = "#/fp-user";
    }
  }
}

export async function initLockdownPage() {
  await mountMobileHeader({
    title: "긴급 경보",
    pageType: "login",
    backTo: "#/lockdown",
    showLogout: false
  });

  document.body.classList.add("lockdown-mode");
  sessionStorage.setItem(LOCKDOWN_SESSION_FLAG, "1");
  setGuard(true);

  connectWebSocket(SITE);
  sendWebSocketMessage({ type: "FP_STOP_REQUEST", site: SITE, reason: "lockdown", turnOffLed: true });
  const off = onWebSocketEvent("LOCKDOWN_STATUS", (msg) => {
    if (msg?.site && msg.site !== SITE) return;
    handleStatus(msg);
  });
  unsubscribes.push(off);
  sendWebSocketMessage({ type: "LOCKDOWN_STATUS_REQUEST", site: SITE });
}