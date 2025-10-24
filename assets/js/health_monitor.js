import { getApiBase, getFpLocalBase } from "./util.js";

const POLL_INTERVAL_MS = 10000;
const INITIAL_TIMEOUT_MS = 4500;
const numberFormatter = new Intl.NumberFormat("ko-KR");

let monitorEl = null;
let lastUpdatedEl = null;
let pollTimer = null;
let refreshing = false;
let initialized = false;

function resolveUrl(base, path) {
  const cleanBase = (base || "").trim();
  if (!cleanBase) return path;
  return cleanBase.replace(/\/?$/, "") + path;
}

function ensureMonitorElement() {
  if (monitorEl && monitorEl.dataset.bound === "1") {
    if (!lastUpdatedEl || !lastUpdatedEl.isConnected) {
      lastUpdatedEl = monitorEl.querySelector('[data-role="updated"]');
    }
    return monitorEl;
  }

  let el = document.getElementById("status-monitor");
  if (!el) {
    el = document.createElement("section");
    el.id = "status-monitor";
  }
  el.classList.add("status-monitor");
  el.dataset.bound = "1";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-label", "시스템 연결 상태");
  el.innerHTML = `
    <div class="status-monitor-heading" aria-hidden="true">연결</div>
    <div class="status-monitor-items" role="list">
      ${createItemTemplate("render", "서버")}
      ${createItemTemplate("db", "DB")}
      ${createItemTemplate("local", "로컬")}
    </div>
    <div class="status-monitor-updated">업데이트 <span data-role="updated">—</span></div>
  `;

  monitorEl = el;
  lastUpdatedEl = monitorEl.querySelector('[data-role="updated"]');
  return monitorEl;
}

function createItemTemplate(key, label) {
  return `
    <div class="status-item" role="listitem" data-key="${key}" data-state="checking">
      <span class="status-dot" aria-hidden="true"></span>
      <span class="status-label">${label}</span>
      <span class="status-value">확인중…</span>
      <span class="status-detail sr-only"></span>
    </div>
  `;
}

function placeMonitor() {
  const el = ensureMonitorElement();
  const body = document.body || document.getElementsByTagName("body")[0];
  if (body && el.parentNode !== body) {
    body.appendChild(el);
  }
  return el;
}

function setState(key, state, value, detail) {
  const el = monitorEl?.querySelector?.(`.status-item[data-key="${key}"]`);
  if (!el) return;
  el.dataset.state = state;
  const valueEl = el.querySelector(".status-value");
  if (valueEl) valueEl.textContent = value;
  const detailEl = el.querySelector(".status-detail");
  if (detailEl) {
    detailEl.textContent = detail || "";
    detailEl.setAttribute("aria-hidden", detail ? "false" : "true");
  }
  const label = el.querySelector(".status-label")?.textContent || key;
  const tooltip = detail ? `${label}: ${detail}` : `${label}: ${value}`;
  el.setAttribute("title", tooltip);
  el.setAttribute("aria-label", `${label} ${value}${detail ? `, ${detail}` : ""}`);
}

function markChecking() {
  setState("render", "checking", "확인중…", "");
  setState("db", "checking", "확인중…", "");
  setState("local", "checking", "확인중…", "");
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });
  } catch (e) {
    return "—";
  }
}

async function fetchJson(url, { timeoutMs = INITIAL_TIMEOUT_MS } = {}) {
  if (!url) return { ok: false, skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(err) {
  if (!err) return "응답 없음";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "에러";
  if (err && typeof err === "object" && err.message) return String(err.message);
  return "연결 오류";
}

function formatRobotSummary(summary) {
  if (!summary || typeof summary !== "object") return "";
  const parts = [];
  const action = summary.actionLabel || summary.action;
  if (action) parts.push(action);
  const includes = summary.includes;
  if (includes && typeof includes === "object") {
    if (includes.label) {
      parts.push(includes.label);
    } else {
      const includeParts = [];
      if (includes.firearm) includeParts.push("총기");
      if (includes.ammo) includeParts.push("탄약");
      if (includeParts.length) parts.push(includeParts.join("+"));
    }
  }
  if (summary.firearmCode) {
    parts.push(`총기 ${summary.firearmCode}`);
  }
  if (summary.ammoSummary) {
    parts.push(`탄약 ${summary.ammoSummary}`);
  } else if (typeof summary.ammoCount === "number") {
    parts.push(`탄약 ${numberFormatter.format(summary.ammoCount)}`);
  }
  if (!summary.firearmCode && summary.locker) {
    parts.push(`보관 ${summary.locker}`);
  }
  if (summary.location && summary.location !== summary.site) {
    parts.push(`위치 ${summary.location}`);
  }
  if (summary.site) {
    parts.push(`현장 ${summary.site}`);
  }
  return parts.join(" · ");
}

export async function refreshStatusMonitor() {
  ensureMonitorElement();
  placeMonitor();
  if (refreshing) return;
  refreshing = true;
  if (!initialized) {
    markChecking();
  }

  try {
    const apiBase = getApiBase();
    const localBase = getFpLocalBase();
    const [http, db, local] = await Promise.all([
      fetchJson(resolveUrl(apiBase, "/health")),
      fetchJson(resolveUrl(apiBase, "/health/db"), { timeoutMs: 5200 }),
      fetchJson(resolveUrl(localBase, "/health"))
    ]);

    const now = Date.now();

    const httpOk = !!(http.ok && http.data && (http.data.ok === true || http.data.status === "ok"));
    const httpState = httpOk ? "online" : (http.ok ? "degraded" : "offline");
    const httpLabel = httpState === "online" ? "정상" : (httpState === "degraded" ? "주의" : "끊김");
    const httpDetail = httpOk ? `응답 ${http.status || 200}` : describeError(http.error) || `HTTP ${http.status || 0}`;
    setState("render", httpState, httpLabel, httpDetail);

    const dbOk = !!(db.ok && db.data && (db.data.db || db.data.ok || db.data.firearms_total !== undefined));
    let dbDetail = "";
    if (dbOk) {
      const firearms = db.data?.firearms_total;
      const ammo = db.data?.ammo_total;
      if (firearms !== undefined || ammo !== undefined) {
        dbDetail = `총기 ${firearms ?? "-"} · 탄약 ${ammo ?? "-"}`;
      } else {
        dbDetail = "연결됨";
      }
    } else {
      dbDetail = describeError(db.error) || `HTTP ${db.status || 0}`;
    }
    setState("db", dbOk ? "online" : (db.ok ? "degraded" : "offline"), dbOk ? "정상" : "오류", dbDetail);

    const localOk = !!(local.ok && local.data && local.data.ok !== false);
    let localState = localOk ? "online" : "offline";
    let localValue = localOk ? "대기 중" : "끊김";
    let localDetail = localOk ? "센서 상태 미확인" : describeError(local.error);
    if (localOk) {
      const robot = local.data?.robot || {};
      const activeRobot = robot?.active;
      const lastRobot = robot?.last;
      const serialConnected = !!local.data?.serial?.connected;
      const manualActive = !!local.data?.identify?.manual?.active;
      const running = !!local.data?.identify?.running;
      const sessionInfo = local.data?.identify?.manual;
      const path = local.data?.serial?.path;
      const activeSummaryText = formatRobotSummary(activeRobot?.summary);
      const lastSummaryText = formatRobotSummary(lastRobot?.summary);

      if (!serialConnected) {
        localState = "degraded";
        localValue = "센서 미연결";
        localDetail = "센서를 찾을 수 없습니다.";
      } else if (activeRobot && activeRobot.status === "running") {
        localState = "online";
        localValue = "장비 동작 중";
        const stage = activeRobot.stage ? `${activeRobot.stage}` : "장비 명령";
        const message = activeRobot.message || "장비 제어 진행 중";
        const summaryInfo = activeSummaryText ? `${activeSummaryText}` : "";
        localDetail = summaryInfo ? `${summaryInfo} · ${message} (${stage})` : `${message} (${stage})`;
      } else if (manualActive || running) {
        localState = "online";
        localValue = "스캔 중";
        if (sessionInfo?.deadline) {
          const remainMs = Math.max(0, sessionInfo.deadline - now);
          const remainSec = Math.round(remainMs / 1000);
          localDetail = `지문 대기 중 (${remainSec}s)`;
        } else {
          localDetail = "지문 대기 중";
        }
      } else if (lastRobot && lastRobot.status === "failed") {
        localState = "degraded";
        localValue = "장비 오류";
        const summaryInfo = lastSummaryText ? `${lastSummaryText} · ` : "";
        localDetail = `${summaryInfo}${lastRobot.message || "최근 장비 명령 실패"}`;
      } else if (robot.enabled === false) {
        localState = "degraded";
        localValue = "장비 비활성";
        localDetail = "장비 제어가 비활성화되었습니다.";
      } else if (robot.enabled && robot.scriptExists === false) {
        localState = "degraded";
        localValue = "장비 준비 필요";
        localDetail = "제어 스크립트를 찾을 수 없습니다.";
      } else {
        localState = "online";
        localValue = "대기 중";
        const baseDetail = path ? `센서 연결됨 (${path})` : "센서 연결됨";
        localDetail = lastSummaryText ? `${baseDetail} · 마지막 ${lastSummaryText}` : baseDetail;
      }
    } else {
      const baseHost = (localBase || "").trim();
      const isLoopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i.test(baseHost);
      const currentHost = (location.hostname || "").toLowerCase();
      const isRemotePage = !!(currentHost && !["localhost", "127.0.0.1", "[::1]"].includes(currentHost));
      if (isLoopback && isRemotePage) {
        const hint = "다른 기기에서 접속 중이라면 로컬 브릿지 주소를 지정해야 합니다. 주소창 끝에 '?fp=http://브릿지PC_IP:8790'을 붙여 다시 접속하거나, 해당 값을 localStorage 'AAMS_FP_LOCAL_BASE'에 저장하세요.";
        localDetail = localDetail ? `${localDetail} · ${hint}` : hint;
      }
    }
    setState("local", localState, localValue, localDetail);

    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = formatTime(now);
    }
    initialized = true;
  } catch (error) {
    console.warn("[AAMS][status] 상태 갱신 실패", error);
  } finally {
    refreshing = false;
  }
}

export function mountStatusMonitor(options = {}) {
  placeMonitor();
  if (!pollTimer) {
    refreshStatusMonitor();
    pollTimer = setInterval(() => { refreshStatusMonitor(); }, POLL_INTERVAL_MS);
  } else if (options.immediate !== false) {
    refreshStatusMonitor();
  }
}

export function unmountStatusMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  refreshing = false;
  initialized = false;
  if (monitorEl && monitorEl.parentNode) {
    monitorEl.parentNode.removeChild(monitorEl);
  }
  monitorEl = null;
  lastUpdatedEl = null;
}
