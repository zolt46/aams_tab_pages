// assets/js/user.js
import {
  fetchMyPendingApprovals,
  fetchRequestDetail,
  connectWebSocket,
  sendWebSocketMessage,
  onWebSocketEvent
} from "./api.js";
import { getMe, renderMeBrief, mountMobileHeader } from "./util.js"
import { setExecuteContext, loadExecuteContext } from "./execute_context.js";

const numberFormatter = new Intl.NumberFormat("ko-KR");
const SITE = window.FP_SITE || "site-01";
const detailCache = new Map();
const robotJobWaiters = new Map();
let robotEventWatcherBound = false;

const ROBOT_SUCCESS_STATUSES = new Set(["success", "succeeded", "done", "completed"]);
const ROBOT_FAILURE_STATUSES = new Set(["failed", "error", "timeout", "cancelled", "canceled"]);

const STATUS_METADATA = {
  APPROVED: {
    label: "승인됨",
    hint: "집행 버튼을 누르면 Render 서버를 통해 로컬 브릿지로 명령이 전달되고, 장비 제어 파이썬 스크립트가 호출될 준비를 합니다.",
    icon: "🗳️"
  },
  DISPATCH_PENDING: {
    label: "장비 명령 대기",
    hint: "집행 명령이 접수되어 로컬 브릿지가 장비 제어 코드 호출을 준비하고 있습니다.",
    icon: "⏳"
  },
  DISPATCHING: {
    label: "명령 전달 중",
    hint: "로컬 브릿지가 로봇·레일 제어 스크립트로 보낼 명령 패키지를 구성하는 단계입니다.",
    icon: "📤"
  },
  DISPATCHED: {
    label: "명령 전달 완료",
    hint: "명령이 로컬 브릿지에 전달되었으며, 파이썬 제어 스크립트의 응답을 기다리고 있습니다.",
    icon: "🤝"
  },
  EXECUTING: {
    label: "장비 동작 중",
    hint: "로봇·레일 장비가 동작 중입니다. 완료되면 상태가 자동으로 갱신됩니다.",
    icon: "⚙️"
  },
  EXECUTED: {
    label: "집행 완료",
    hint: "장비 제어가 정상적으로 완료되었습니다.",
    icon: "✅"
  },
  COMPLETED: {
    label: "집행 완료",
    hint: "장비 제어가 정상적으로 완료되었습니다.",
    icon: "✅"
  },
  DISPATCH_FAILED: {
    label: "장비 전달 실패",
    hint: "로컬 브릿지 또는 장비와의 통신에서 문제가 발생했습니다. 원인을 확인한 뒤 집행을 다시 시도할 수 있습니다.",
    icon: "⚠️",
    retryable: true
  },
  EXECUTION_FAILED: {
    label: "장비 동작 오류",
    hint: "장비 제어 중 오류가 발생했습니다. 장비 상태를 확인한 뒤 집행을 다시 시도하세요.",
    icon: "⚠️",
    retryable: true
  }
};

const ROBOT_PROGRESS_KEYS = new Set(["DISPATCH_PENDING", "DISPATCHING", "DISPATCHED", "EXECUTING"]);

const EXECUTION_COMPLETE_STATUSES = new Set(["EXECUTED", "COMPLETED"]);
const ROBOT_STAGE_LABELS = {
  queued: "명령 준비",
  dispatched: "전달 완료",
  executing: "장비 동작 중",
  progress: "장비 동작 중",
  success: "완료",
  completed: "완료",
  failed: "실패",
  error: "오류",
  timeout: "시간 초과"
};

function normalizeRobotRequestId(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  return str ? str : null;
}

function isRobotFailureStatus(status) {
  if (!status) return false;
  return ROBOT_FAILURE_STATUSES.has(String(status).toLowerCase());
}

function isRobotSuccessStatus(status) {
  if (!status) return false;
  return ROBOT_SUCCESS_STATUSES.has(String(status).toLowerCase());
}

function isRobotFinalStatus(status) {
  return isRobotFailureStatus(status) || isRobotSuccessStatus(status);
}

function evaluateRobotSnapshot(snapshot) {
  if (!snapshot) return null;
  const job = snapshot.job || {};
  const requestId = normalizeRobotRequestId(snapshot.requestId || job.requestId || job.request_id || job.requestID);
  if (!requestId) return null;
  const status = String(job.status || "").toLowerCase();
  const errorMessage = snapshot.error || job.error || null;
  const final = snapshot.final === true || job.final === true || isRobotFinalStatus(status);
  if (!final && !errorMessage) {
    return { requestId, pending: true, job };
  }
  if (errorMessage || isRobotFailureStatus(status)) {
    return {
      requestId,
      job,
      error: errorMessage || job.message || "robot_failed"
    };
  }
  return {
    requestId,
    job,
    ok: true
  };
}

function ensureRobotEventWatcher() {
  if (robotEventWatcherBound) return;
  robotEventWatcherBound = true;
  onWebSocketEvent("ROBOT_EVENT", handleRobotEventForWaiters);
}

function handleRobotEventForWaiters(eventMessage) {
  if (!eventMessage || eventMessage.type !== "ROBOT_EVENT") return;
  const job = eventMessage.job || {};
  const requestId = normalizeRobotRequestId(
    eventMessage.requestId
      || eventMessage.request_id
      || job.requestId
      || job.request_id
      || job.requestID
  );

  if (!requestId) {
    if (eventMessage.error && robotJobWaiters.size === 1) {
      const [[key, waiter]] = robotJobWaiters.entries();
      robotJobWaiters.delete(key);
      if (waiter.timer) clearTimeout(waiter.timer);
      const err = new Error(eventMessage.error);
      err.response = { job, message: eventMessage };
      waiter.reject(err);
    }
    return;
  }

  const waiter = robotJobWaiters.get(requestId);
  if (!waiter) return;

  const status = String(job.status || "").toLowerCase();
  const final = eventMessage.final === true || job.final === true || isRobotFinalStatus(status);
  const errorMessage = eventMessage.error || job.error || null;

  if (!final && !errorMessage) {
    return;
  }

  robotJobWaiters.delete(requestId);
  if (waiter.timer) clearTimeout(waiter.timer);

  if (errorMessage || isRobotFailureStatus(status)) {
    const err = new Error(errorMessage || job.message || "robot_failed");
    err.response = { job, message: eventMessage };
    waiter.reject(err);
    return;
  }

  waiter.resolve({ requestId, job, message: eventMessage });
}

function waitForRobotCompletion(requestId, { timeoutMs = 90000 } = {}) {
  const key = normalizeRobotRequestId(requestId);
  if (!key) {
    return Promise.reject(new Error("로봇 요청 ID가 필요합니다."));
  }
  if (robotJobWaiters.has(key)) {
    const existing = robotJobWaiters.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    robotJobWaiters.delete(key);
  }
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    robotJobWaiters.delete(key);
    reject(new Error("로컬 브릿지 응답 시간 초과"));
  }, timeoutMs) : null;
  robotJobWaiters.set(key, { resolve, reject, timer });
  return promise;
}

function getActiveExecuteContext() {
  try {
    const context = loadExecuteContext();
    return context || null;
  } catch (err) {
    console.warn("[AAMS][user] 실행 컨텍스트 확인 실패:", err?.message || err);
    return null;
  }
}

function isContextActive(context) {
  if (!context || typeof context !== "object") return false;
  if (!context.requestId) return false;
  const state = String(context.state || "").toLowerCase();
  return state !== "completed" && state !== "failed";
}

function isExecutionPendingStatus(status) {
  const key = String(status || "").trim().toUpperCase();
  if (!key) return false;
  if (EXECUTION_COMPLETE_STATUSES.has(key)) return false;
  return true;
}

function getLatestApprovalTimestamp(row = {}) {
  const approvalFromDetail = Array.isArray(row?.raw?.approvals)
    ? row.raw.approvals
        .filter((entry) => entry && entry.decision === "APPROVE" && entry.decided_at)
        .sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at))[0]?.decided_at
    : null;

  return row?.approved_at
    || row?.updated_at
    || approvalFromDetail
    || row?.raw?.approved_at
    || row?.raw?.updated_at
    || row?.raw?.request?.approved_at
    || row?.raw?.request?.updated_at
    || row?.created_at
    || row?.requested_at;
}

export async function initUserMain() {
  await mountMobileHeader({ title: "사용자", pageType: "main", showLogout: true });

  connectWebSocket(SITE);

  const me = getMe();
  renderMeBrief(me);
  const greetingEl = document.getElementById("user-hub-greeting");
  if (greetingEl) {
    greetingEl.innerHTML = renderHeroGreeting(me);
  }


  const pendingList = document.getElementById("pending-list");
  const pendingToggle = document.getElementById("pending-toggle");
  const historyList = document.getElementById("history-list");
  const historyToggle = document.getElementById("history-toggle");

  const pendingControls = bindCollapsible(pendingList, pendingToggle, { defaultCollapsed: false });
  const historyControls = bindCollapsible(historyList, historyToggle, { defaultCollapsed: false });

 if (!pendingList) return;

  updateDashboardStats({ pendingCount: "-", totalApproved: "-", latest: "-" });

  pendingControls.setDisabled(true);
  historyControls.setDisabled(true);

  if (historyList) {
    historyList.innerHTML = `<div class="muted">불러오는 중…</div>`;
  }

  if (!me?.id) {
    pendingList.innerHTML = `<div class="error">사용자 정보를 확인할 수 없습니다.</div>`;
    if (historyList) historyList.innerHTML = `<div class="muted">이력 정보를 확인할 수 없습니다.</div>`;
    return;
  }

  pendingList.innerHTML = `<div class="muted">불러오는 중…</div>`;

  try {
    const rows = await fetchMyPendingApprovals(me.id) || [];
    rows.sort((a, b) => new Date(getLatestApprovalTimestamp(b) || 0) - new Date(getLatestApprovalTimestamp(a) || 0));

    const pendingRows = rows.filter((row) => isExecutionPendingStatus(row?.status));
    const completedRows = rows.filter((row) => !isExecutionPendingStatus(row?.status));
    completedRows.sort((a, b) => new Date(getExecutionTimestamp(b) || 0) - new Date(getExecutionTimestamp(a) || 0));

    pendingControls.setDisabled(!pendingRows.length);
    historyControls.setDisabled(!completedRows.length);

    const latestApprovalTs = rows.length ? formatKST(getLatestApprovalTimestamp(rows[0])) : "-";

    updateDashboardStats({
      pendingCount: pendingRows.length,
      totalApproved: rows.length,
      latest: latestApprovalTs
    });

    if (!pendingRows?.length) {
      pendingList.innerHTML = `<div class="muted">집행 대기 건이 없습니다.</div>`;
    } else {
      pendingList.innerHTML = pendingRows.map((row) => renderCard(row)).join("");
      wire(pendingRows, me, { container: pendingList });
    }

    if (historyList) {
      if (completedRows.length) {
        historyList.innerHTML = completedRows.map((row) => renderCard(row, { variant: "history" })).join("");
        historyControls.setCollapsed(false);
        wire(completedRows, me, { container: historyList });
      } else {
        historyList.innerHTML = `<div class="muted">집행 완료된 이력이 없습니다.</div>`;
        historyControls.setCollapsed(true);
      }
    }
  } catch (e) {
    const message = escapeHtml(e?.message || "오류가 발생했습니다.");
    pendingList.innerHTML = `<div class="error">불러오기 실패: ${message}</div>`;
    if (historyList) historyList.innerHTML = `<div class="muted">이력을 불러오지 못했습니다.</div>`;
    updateDashboardStats({ pendingCount: "-", totalApproved: "-", latest: "-" });
    pendingControls.setDisabled(false);
    historyControls.setDisabled(false);
  }
}

export {
  buildDispatchPayload,
  dispatchRobotViaLocal,
  formatKST,
  formatStatusReason,
  formatAmmoLabel,
  resolveStatusInfo
};

function bindCollapsible(listEl, toggleEl, { defaultCollapsed = false } = {}) {
  if (!listEl) {
    return {
      setCollapsed: () => {},
      setDisabled: () => {}
    };
  }

  const setCollapsed = (collapsed) => {
    listEl.classList.toggle("collapsed", !!collapsed);
    if (toggleEl) {
      toggleEl.textContent = collapsed ? "펼치기" : "접기";
      toggleEl.setAttribute("aria-expanded", String(!collapsed));
    }
  };

  const setDisabled = (disabled) => {
    if (!toggleEl) return;
    toggleEl.disabled = !!disabled;
  };

  setCollapsed(!!defaultCollapsed);

  if (toggleEl) {
    toggleEl.addEventListener("click", () => {
      const current = listEl.classList.contains("collapsed");
      setCollapsed(!current);
    });
  }

  return { setCollapsed, setDisabled };
}

function renderCard(r, { variant = "pending" } = {}) {
  const requestId = r?.id ?? r?.raw?.id ?? "";
  const idValue = String(requestId ?? "");
  const idLabel = idValue ? `REQ-${idValue.padStart(4, "0")}` : "REQ----";
  const typeText = r.type === "ISSUE" ? "불출" : (r.type === "RETURN" ? "불입" : (r.type || "요청"));
  const requestedAt = formatKST(r.requested_at || r.created_at) || "-";
  const approvedAt = formatKST(getLatestApprovalTimestamp(r)) || "-";
  const executedAt = variant === "history" ? (formatKST(getExecutionTimestamp(r)) || "-") : null;
  const statusInfo = resolveStatusInfo(r.status, r);
  const statusLabel = statusInfo.label;
  const statusClass = `status-${sanitizeToken(statusInfo.key || r.status || "pending")}`;
  const ammoSummary = formatAmmoSummary(r);
  const requester = r.requester_name ?? r.raw?.requester_name ?? r.raw?.requester?.name ?? "-";
  const weaponCode = r.weapon_code ?? r.weapon?.code ?? r.raw?.weapon_code ?? r.raw?.weapon?.code ?? "-";
  const executeState = getExecuteButtonState(r, statusInfo);
  const executionHint = variant === "history" ? "" : renderExecutionHint(statusInfo);
  const statusReason = formatStatusReason(r);
  const summaryNotice = renderStatusNotice(statusInfo, statusReason, { variant: "summary" });
  const stageVisual = renderRobotStageVisual(statusInfo, r, { variant });
  const detailNotice = renderStatusNotice(statusInfo, statusReason);
  const classes = ["card", "pending-card"];
  if (variant === "history") classes.push("history-card");

  return `
    <article class="${classes.join(" ")}" data-id="${escapeHtml(requestId)}">
      <header class="card-header">
        <div class="card-title">
          <span class="chip">${escapeHtml(idLabel)}</span>
          <span class="chip">${escapeHtml(typeText)}</span>
        </div>
        <span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span>
      </header>
      <div class="card-summary">
        <div class="summary-item">
          <span class="label">총기</span>
          <span class="value">${escapeHtml(weaponCode || "-")}</span>
        </div>
        <div class="summary-item">
          <span class="label">탄약</span>
          <span class="value">${escapeHtml(ammoSummary)}</span>
        </div>
        <div class="summary-item">
          <span class="label">신청자</span>
          <span class="value">${escapeHtml(requester || "-")}</span>
        </div>
        <div class="summary-item">
          <span class="label">요청 시간</span>
          <span class="value">${escapeHtml(requestedAt)}</span>
        </div>
        <div class="summary-item">
          <span class="label">승인 시간</span>
          <span class="value">${escapeHtml(approvedAt)}</span>
        </div>
        ${executedAt ? `
        <div class="summary-item">
          <span class="label">집행 완료</span>
          <span class="value">${escapeHtml(executedAt)}</span>
        </div>` : ""}
      </div>
      ${stageVisual}
      ${summaryNotice}
      <footer class="card-actions">
        ${variant === "history" ? "" : `
        <button class="btn primary" data-act="execute" data-id="${escapeHtml(requestId)}"${executeState.disabled ? " disabled" : ""}${executeState.resume ? " data-resume=\"true\"" : ""}>
          <span class="btn-label">${escapeHtml(executeState.label)}</span>
        </button>`}
        <button class="btn ghost detail-btn" data-act="detail" data-id="${escapeHtml(requestId)}" aria-expanded="false">
          <span class="btn-label">상세 보기</span>
          <span class="chevron">⌄</span>
        </button>
      </footer>
      <div class="card-detail hidden" data-id="${escapeHtml(requestId)}">
        <div class="detail-grid">
          <div>
            <span class="term">요청 유형</span>
            <span class="desc">${escapeHtml(typeText)}</span>
          </div>
          <div>
            <span class="term">상태</span>
            <span class="desc">${escapeHtml(statusLabel)}</span>
          </div>
          <div>
            <span class="term">신청자</span>
            <span class="desc">${escapeHtml(requester || "-")}</span>
          </div>
          <div>
            <span class="term">요청 시간</span>
            <span class="desc">${escapeHtml(requestedAt)}</span>
          </div>
          <div>
            <span class="term">승인 시간</span>
            <span class="desc">${escapeHtml(approvedAt)}</span>
          </div>
          ${executedAt ? `
          <div>
            <span class="term">집행 완료</span>
            <span class="desc">${escapeHtml(executedAt)}</span>
          </div>` : ""}
          <div>
            <span class="term">총기</span>
            <span class="desc">${escapeHtml(weaponCode || "-")}</span>
          </div>
          <div>
            <span class="term">탄약</span>
            <span class="desc">${escapeHtml(ammoSummary)}</span>
            ${renderAmmoList(r)}
          </div>
        </div>
        ${detailNotice}
        ${executionHint}
        <section class="robot-detail" data-robot="${escapeHtml(requestId)}">
          <div class="muted">상세를 펼치면 장비 제어 이력이 표시됩니다.</div>
        </section>
      </div>
    </article>`;
}

function formatKST(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function wire(rows = [], me = null, { container = document } = {}) {
  const requestMap = new Map();
  (rows || []).forEach((row) => {
    const key = String(row?.id ?? row?.raw?.id ?? "");
    if (key) {
      requestMap.set(key, row);
    }
  });

  (container?.querySelectorAll?.('[data-act="detail"]') || []).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const detail = document.querySelector(`.card-detail[data-id="${id}"]`);
      if (!detail) return;
      const isHidden = detail.classList.toggle("hidden");
      const expanded = !isHidden;
      btn.setAttribute("aria-expanded", String(expanded));
      btn.classList.toggle("is-open", expanded);
      const label = btn.querySelector(".btn-label");
      if (label) label.textContent = expanded ? "상세 닫기" : "상세 보기";
      if (expanded) {
        const row = requestMap.get(String(id));
        await populateRobotDetail({ requestId: id, row, container: detail });
      }
    });
  });

  (container?.querySelectorAll?.('[data-act="execute"]') || []).forEach((btn) => {
    btn.addEventListener("click", () => {
      const requestIdStr = btn.getAttribute("data-id");
      if (!requestIdStr) return;
      const requestKey = String(requestIdStr);
      const executor = me || getMe();
      const snapshot = requestMap.get(requestKey) || null;
      const resumeRequested = btn.getAttribute("data-resume") === "true";
      const activeContext = getActiveExecuteContext();

      let nextContext;

      if (
        resumeRequested
        && isContextActive(activeContext)
        && String(activeContext.requestId) === requestKey
      ) {
        nextContext = { ...activeContext };
        if (snapshot) {
          nextContext.row = snapshot;
        }
        if (!nextContext.executor && executor) {
          nextContext.executor = executor;
        }
        if (!nextContext.state || nextContext.state === "completed" || nextContext.state === "failed") {
          nextContext.state = "pending";
        }
      } else {
        nextContext = {
          requestId: requestIdStr,
          row: snapshot,
          executor,
          state: 'pending',
          createdAt: Date.now()
        };
      }

      setExecuteContext(nextContext);

      location.hash = "#/execute";
    });
  });
}

async function populateRobotDetail({ requestId, row, container }) {
  if (!container) return;
  const target = container.querySelector(`.robot-detail[data-robot="${escapeSelector(requestId)}"]`) || container.querySelector('.robot-detail');
  if (!target) return;
  if (!requestId) {
    target.innerHTML = '<div class="error">요청 ID를 확인할 수 없습니다.</div>';
    return;
  }

  const cacheKey = String(requestId);
  const loadingHtml = '<div class="muted">장비 제어 이력을 불러오는 중…</div>';
  target.innerHTML = loadingHtml;

  try {
    let detail = detailCache.get(cacheKey);
    if (!detail) {
      detail = await fetchRequestDetail(requestId, { force: true });
      detailCache.set(cacheKey, detail);
    }
    target.innerHTML = renderRobotDetail(detail, row, { requestId: cacheKey });
  } catch (err) {
    target.innerHTML = `<div class="error">불러오기 실패: ${escapeHtml(err?.message || '오류')}</div>`;
  }
}

function renderRobotDetail(detail, row, { requestId } = {}) {
  if (!detail) {
    return '<div class="muted">장비 제어 이력이 없습니다.</div>';
  }

  const dispatchPayload = buildDispatchPayload({
    requestId,
    row,
    detail,
    executor: null
  });

  const statusReason = detail?.request?.status_reason || formatStatusReason(row);
  const statusHtml = statusReason
    ? `<p class="robot-status">${escapeHtml(statusReason)}</p>`
    : '';

  const dispatchHtml = dispatchPayload
    ? `<details class="robot-dispatch" open><summary>전송된 장비 명령</summary><pre>${escapeHtml(JSON.stringify(dispatchPayload, null, 2))}</pre></details>`
    : '<div class="muted">장비 명령 데이터가 없습니다.</div>';

  const timelineHtml = renderRobotTimeline(detail?.executions || []);

  return `${statusHtml}${dispatchHtml}${timelineHtml}`;
}

function renderRobotTimeline(events = []) {
  if (!Array.isArray(events) || events.length === 0) {
    return '<div class="muted">장비 제어 이벤트가 아직 기록되지 않았습니다.</div>';
  }

  const items = events
    .slice()
    .sort((a, b) => new Date(a.executed_at || a.created_at || 0) - new Date(b.executed_at || b.created_at || 0))
    .map(renderRobotTimelineItem)
    .join('');

  return `<ol class="robot-events">${items}</ol>`;
}

function renderRobotTimelineItem(event = {}) {
  const notes = parseExecutionNotes(event.notes);
  const stage = notes?.stage || event.event_type || 'unknown';
  const normalizedStage = String(stage || '').toLowerCase();
  const ts = formatKST(event.executed_at || event.created_at) || '-';

  const displayStage = ROBOT_STAGE_LABELS[normalizedStage] || stage;

  const messageParts = [];
  if (notes?.job?.summary?.actionLabel) messageParts.push(notes.job.summary.actionLabel);
  if (notes?.dispatch?.includes?.label) messageParts.push(notes.dispatch.includes.label);
  if (notes?.reason) messageParts.push(notes.reason);
  if (notes?.job?.message) messageParts.push(notes.job.message);
  if (notes?.job?.status && !messageParts.includes(notes.job.status)) messageParts.push(`상태: ${notes.job.status}`);
  if (!messageParts.length && typeof event.notes === 'string') {
    messageParts.push(event.notes);
  }

  const payloadPreview = (normalizedStage === 'queued' || normalizedStage === 'dispatched')
    ? (notes?.payload?.dispatch || notes?.dispatch)
    : null;
  const payloadSnippet = payloadPreview
    ? `<pre>${escapeHtml(JSON.stringify(payloadPreview, null, 2))}</pre>`
    : '';

  return `
    <li class="robot-event">
      <div class="event-time">${escapeHtml(ts)}</div>
      <div class="event-stage">${escapeHtml(displayStage)}</div>
      <div class="event-message">${messageParts.length ? escapeHtml(messageParts.join(' · ')) : '-'}</div>
      ${payloadSnippet}
    </li>`;
}

function parseExecutionNotes(notes) {
  if (!notes) return null;
  if (typeof notes === 'object') return notes;
  try {
    return JSON.parse(notes);
  } catch (err) {
    return null;
  }
}

function updateDashboardStats({ pendingCount = "-", totalApproved = "-", latest = "-" } = {}) {
  const pendingText = formatCount(pendingCount);
  document.querySelectorAll('#pending-count, [data-stat="pending-count"]').forEach((el) => {
    el.textContent = pendingText;
  });

  const totalText = formatCount(totalApproved);
  document.querySelectorAll('#total-approved, [data-stat="total-approved"]').forEach((el) => {
    el.textContent = totalText;
  });

  const latestText = latest && latest !== "-" ? latest : "-";
  document.querySelectorAll('#latest-request, [data-stat="latest-request"]').forEach((el) => {
    el.textContent = latestText;
  });
}

function getExecutionTimestamp(row = {}) {
  return row?.executed_at
    || row?.raw?.executed_at
    || row?.raw?.execution_completed_at
    || row?.updated_at
    || getLatestApprovalTimestamp(row)
    || null;
}

function formatCount(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (value === "-") return "-";
  const num = Number(value);
  if (Number.isFinite(num)) {
    return numberFormatter.format(num);
  }
  return String(value);
}

function renderHeroGreeting(me = {}) {
  if (!me?.id) {
    return "사용자 인증을 완료하면 승인된 집행 현황을 확인할 수 있습니다.";
  }
  const nameParts = [];
  if (me.rank) nameParts.push(escapeHtml(me.rank));
  nameParts.push(escapeHtml(me.name || "사용자"));
  const name = nameParts.join(" ");
  const unit = me.unit || me.unit_name;
  const lines = [`<strong>${name}</strong>님, 환영합니다.`];
  if (unit) {
    lines.push(`${escapeHtml(unit)} 소속으로 확인되었습니다.`);
  }
  return lines.join(" ");
}

function resolveStatusInfo(status, row = {}) {
  let key = String(status || "").trim().toUpperCase();
  if (!key) {
    return { key: "PENDING", label: "대기" };
  }

  if (key === "APPROVED") {
    const reason = formatStatusReason(row).toLowerCase();
    if (reason) {
      if (/(오류|에러|실패)/.test(reason)) {
        key = "DISPATCH_FAILED";
      } else if (/(동작|진행)/.test(reason)) {
        key = "EXECUTING";
      } else if (/(대기|준비)/.test(reason)) {
        key = "DISPATCH_PENDING";
      }
    }
  }

  const meta = STATUS_METADATA[key];
  if (meta) {
    return { key, ...meta };
  }
  return { key, label: status };
}

function getExecuteButtonState(row, statusInfo = {}) {
  const key = statusInfo.key || String(row?.status || "").trim().toUpperCase();
  const activeContext = getActiveExecuteContext();
  const activeRequestId = isContextActive(activeContext) ? String(activeContext.requestId) : null;
  const rowRequestId = row?.id ?? row?.raw?.id ?? null;
  const matchesActive = activeRequestId && rowRequestId !== null && String(rowRequestId) === activeRequestId;
  if (!key || key === "APPROVED") {
    return { label: "집행", disabled: false };
  }
  if (key === "DISPATCH_FAILED" || key === "EXECUTION_FAILED") {
    return { label: "재시도", disabled: false };
  }
  if (key === "EXECUTED" || key === "COMPLETED") {
    return { label: "완료", disabled: true };
  }
  if (["DISPATCH_PENDING", "DISPATCHING", "DISPATCHED", "EXECUTING"].includes(key)) {
    if (matchesActive) {
      return { label: "재개", disabled: false, resume: true };
    }
    return { label: statusInfo.label || "처리 중", disabled: true };
  }
  return { label: statusInfo.label || "집행", disabled: false };
}

function renderExecutionHint(statusInfo = {}) {
  if (!statusInfo.hint) return "";
  const icon = statusInfo.icon ? `<span class="icon" aria-hidden="true">${escapeHtml(statusInfo.icon)}</span>` : "";
  return `<p class="card-hint">${icon}${escapeHtml(statusInfo.hint)}</p>`;
}

function formatStatusReason(row = {}) {
  const candidates = [
    row.status_reason,
    row.raw?.status_reason,
    row.raw?.request?.status_reason,
    row.raw?.dispatch_reason,
    row.raw?.execution_reason
  ];
  const value = candidates.find((v) => typeof v === "string" && v.trim());
  return value ? value.trim() : "";
}

function renderStatusNotice(statusInfo = {}, reason = "", { variant = "detail" } = {}) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) return "";
  const key = String(statusInfo.key || "").toUpperCase();
  const isError = key.includes("FAILED") || ["DISPATCH_FAILED", "EXECUTION_FAILED"].includes(key);
  const classes = ["card-alert", variant === "summary" ? "compact" : ""];
  if (!isError) classes.push("info");
  const icon = isError ? "⚠️" : "ℹ️";
  return `<p class="${classes.filter(Boolean).join(" ")}"><span class="icon" aria-hidden="true">${icon}</span><span>${escapeHtml(text)}</span></p>`;
}

function renderRobotStageVisual(statusInfo = {}, row = {}, { variant = "pending" } = {}) {
  if (variant === "history") return "";

  const key = String(statusInfo.key || row?.status || "APPROVED").toUpperCase();
  const active = shouldShowRobotStage(statusInfo, row);
  const label = statusInfo.label || "집행 진행 중";
  const reason = formatStatusReason(row) || statusInfo.hint || `${label}이 진행 중입니다.`;
  const stageToken = sanitizeToken(key || "pending");
  const ariaHidden = active ? "false" : "true";
  const classes = ["robot-stage", active ? "is-active" : ""].filter(Boolean).join(" ");

  return `
    <section class="${classes}" data-stage="${escapeHtml(stageToken)}" data-default-active="${active}" aria-hidden="${ariaHidden}">
      <div class="robot-visual" aria-hidden="true">
        <div class="robot-avatar">
          <div class="robot-antenna"></div>
          <div class="robot-head">
            <span class="eye left"></span>
            <span class="eye right"></span>
          </div>
          <div class="robot-mouth"></div>
          <div class="robot-body">
            <span class="panel-dot"></span>
            <span class="panel-dot"></span>
            <span class="panel-dot"></span>
          </div>
          <div class="robot-arm left"></div>
          <div class="robot-arm right"></div>
        </div>
        <div class="robot-progress">
          <span></span><span></span><span></span><span></span>
        </div>
      </div>
      <div class="robot-stage-text" role="status" aria-live="polite">
        <p class="robot-stage-label">${escapeHtml(label)}</p>
        <p class="robot-stage-message">${escapeHtml(reason)}</p>
      </div>
    </section>`;
}

function shouldShowRobotStage(statusInfo = {}, row = {}) {
  const key = String(statusInfo.key || row?.status || "").toUpperCase();
  if (ROBOT_PROGRESS_KEYS.has(key)) return true;
  const reason = formatStatusReason(row);
  if (!reason) return false;
  return /(대기|준비|전달|진행|동작|기다리는|기다림)/.test(reason.toLowerCase());
}

function mergeFirearmSources(localFirearm, serverFirearm) {
  if (!localFirearm && !serverFirearm) return undefined;
  const merged = pruneEmpty({
    ...(localFirearm || {}),
    ...(serverFirearm || {})
  });
  return merged || undefined;
}

function buildDispatchPayload({ requestId, row = {}, detail = {}, executor = {} } = {}) {
  const request = detail?.request || row?.raw?.request || row?.raw || {};
  const serverDispatch = detail?.dispatch || {};
  const firearmLocal = extractFirearmInfo(row, detail);
  const firearm = mergeFirearmSources(firearmLocal, serverDispatch?.firearm);

  const ammoLocal = extractAmmoPayload(row, detail);
  const ammoFromServer = Array.isArray(serverDispatch?.ammo) ? serverDispatch.ammo : null;
  const ammo = (ammoFromServer && ammoFromServer.length) ? ammoFromServer : ammoLocal;

  const includesLocal = {
    firearm: Boolean(firearmLocal || firearm),
    ammo: ammoLocal.length > 0
  };

  const includes = pruneEmpty({
    firearm: serverDispatch?.includes?.firearm ?? includesLocal.firearm,
    ammo: serverDispatch?.includes?.ammo ?? includesLocal.ammo
  });

  const mode = serverDispatch?.mode
    || (includes?.firearm && includes?.ammo
      ? "firearm_and_ammo"
      : (includes?.firearm ? "firearm_only" : (includes?.ammo ? "ammo_only" : "none")));

  const locker = serverDispatch?.locker
    || firearm?.locker
    || firearmLocal?.locker
    || serverDispatch?.storage
    || detail?.request?.storage_locker
    || request?.locker
    || request?.locker_code
    || request?.storage
    || request?.storage_code
    || row?.raw?.locker
    || row?.raw?.locker_code
    || row?.raw?.weapon_locker
    || row?.raw?.weapon?.locker
    || row?.raw?.weapon?.locker_code
    || null;

  const location = serverDispatch?.location
    || request?.location
    || detail?.request?.location
    || row?.raw?.request?.location
    || row?.location
    || null;

  const normalizedExecutor = normalizeExecutor(executor) || pruneEmpty(serverDispatch?.executor);

  const payload = pruneEmpty({
    ...serverDispatch,
    request_id: serverDispatch?.request_id
      ?? requestId
      ?? row?.id
      ?? request?.id
      ?? null,
    site_id: serverDispatch?.site_id
      ?? detail?.site_id
      ?? request?.site_id
      ?? request?.site
      ?? row?.raw?.site_id
      ?? null,
    type: serverDispatch?.type
      ?? request?.request_type
      ?? row?.type
      ?? request?.type
      ?? null,
    mode,
    includes,
    firearm: firearm || undefined,
    ammo: ammo && ammo.length ? ammo : undefined,
    locker: locker || undefined,
    location: location || undefined,
    purpose: serverDispatch?.purpose ?? row?.purpose ?? request?.purpose ?? undefined,
    requested_at: serverDispatch?.requested_at ?? request?.requested_at ?? row?.requested_at ?? row?.created_at ?? undefined,
    approved_at: serverDispatch?.approved_at ?? request?.approved_at ?? row?.approved_at ?? undefined,
    status: serverDispatch?.status ?? row?.status ?? request?.status ?? undefined,
    executor: normalizedExecutor || undefined
  });

  const statusReason = row?.status_reason || request?.status_reason;
  const notes = pruneEmpty({
    ...(typeof serverDispatch?.notes === "object" && !Array.isArray(serverDispatch.notes) ? serverDispatch.notes : {}),
    memo: request?.memo || request?.notes,
    status_reason: statusReason
  });

  if (notes) {
    payload.notes = notes;
  } else if (serverDispatch?.notes && typeof serverDispatch.notes !== "object") {
    payload.notes = serverDispatch.notes;
  }

  return payload || undefined;
}

function extractFirearmInfo(row = {}, detail = {}) {
  const detailItems = Array.isArray(detail?.items) ? detail.items : [];
  const request = detail?.request || row?.raw?.request || {};
  const firearms = [];

  if (detailItems.length) {
    detailItems
      .filter((item) => String(item?.item_type || item?.type || "").toUpperCase() === "FIREARM")
      .forEach((item) => firearms.push(item));
  }

  if (Array.isArray(row?.raw?.firearms)) {
    firearms.push(...row.raw.firearms);
  }

  if (row?.raw?.weapon) {
    firearms.push(row.raw.weapon);
  }

  const candidate = firearms[0];

  const code = candidate?.firearm_number
    || candidate?.serial
    || candidate?.code
    || candidate?.weapon_code
    || row?.weapon_code
    || row?.weapon_summary
    || request?.weapon_code
    || null;

  const locker = candidate?.locker
    || candidate?.locker_code
    || candidate?.locker_name
    || candidate?.storage
    || candidate?.storage_code
    || candidate?.firearm_storage_locker
    || candidate?.storage_locker
    || request?.locker
    || request?.locker_code
    || null;

  const slot = candidate?.slot
    || candidate?.slot_number
    || candidate?.rack_slot
    || candidate?.position
    || candidate?.compartment
    || candidate?.compartment_number
    || null;

  const info = pruneEmpty({
    id: candidate?.firearm_id || candidate?.weapon_id || candidate?.id || null,
    code,
    type: candidate?.firearm_type || candidate?.weapon_type || candidate?.type || null,
    locker,
    slot
  });

  if (info) {
    return info;
  }

  if (code) {
    return { code };
  }

  return null;
}

function extractAmmoPayload(row = {}, detail = {}) {
  const detailItems = Array.isArray(detail?.items) ? detail.items : [];
  const ammoItems = [];
  const seen = new Set();

  const push = (item) => {
    if (!item) return;
    const normalized = pruneEmpty({
      code: item.code || item.ammo_code || null,
      name: item.name || item.ammo_name || item.label || item.caliber || item.type || null,
      type: item.type || item.ammo_category || null,
      caliber: item.caliber || item.name || item.ammo_name || null,
      qty: item.qty ?? item.quantity ?? item.count ?? item.amount ?? null,
      unit: item.unit || item.unit_label || item.measure || null
    });
    if (!normalized) return;
    const key = JSON.stringify([
      normalized.code,
      normalized.name,
      normalized.type,
      normalized.caliber,
      normalized.qty,
      normalized.unit
    ]);
    if (seen.has(key)) return;
    seen.add(key);
    ammoItems.push(normalized);
  };

  detailItems
    .filter((item) => String(item?.item_type || item?.type || "").toUpperCase() === "AMMO")
    .forEach(push);

  if (Array.isArray(row?.raw?.ammo_items)) {
    row.raw.ammo_items.forEach(push);
  }

  getAmmoItems(row).forEach(push);

  return ammoItems;
}

async function dispatchRobotViaLocal(payload, { timeoutMs = 90000, resume = false, lastEvent = null } = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("장비 명령 데이터가 없습니다.");
  }

  connectWebSocket(SITE);
  ensureRobotEventWatcher();


  const jobRequestId = normalizeRobotRequestId(
    payload.requestId
      || payload.request_id
      || payload.requestID
      || payload.execution_request_id
  );

  if (!jobRequestId) {
    throw new Error("로봇 요청 ID를 확인할 수 없습니다.");
  }

  if (resume && lastEvent) {
    const snapshot = evaluateRobotSnapshot(lastEvent);
    if (snapshot && snapshot.requestId === jobRequestId) {
      if (snapshot.error) {
        const err = new Error(snapshot.error);
        err.response = { job: snapshot.job || null, snapshot: lastEvent };
        throw err;
      }
      if (snapshot.ok) {
        return { ok: true, requestId: jobRequestId, job: snapshot.job || {} };
      }
    }
  }

  const normalizedTimeout = Number(timeoutMs);
  const effectiveTimeout = Number.isFinite(normalizedTimeout) && normalizedTimeout > 0
    ? normalizedTimeout
    : 0;

  const waitPromise = waitForRobotCompletion(jobRequestId, { timeoutMs: effectiveTimeout });

  if (!resume) {
    const relayRequestId = `robot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const message = {
      type: "ROBOT_EXECUTE",
      requestId: relayRequestId,
      payload: { ...payload }
    };
    if (!message.payload.request_id && !message.payload.requestId) {
      message.payload.request_id = jobRequestId;
    }
    if (effectiveTimeout > 0) {
      message.timeoutMs = effectiveTimeout;
    }
    sendWebSocketMessage(message);
  }

  try {
    const result = await waitPromise;
    return {
      ok: true,
      requestId: result?.requestId || jobRequestId,
      job: result?.job || {}
    };
  } catch (error) {
    if (error?.message === "로컬 브릿지 응답 시간 초과") {
      throw error;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function setCardBusyState(card, busy) {
  if (!card) return;
  card.classList.toggle("robot-busy", !!busy);
  const stage = card.querySelector('.robot-stage');
  if (!stage) return;
  const defaultActive = stage.dataset && stage.dataset.defaultActive === 'true';
  const shouldShow = busy ? true : defaultActive;
  stage.classList.toggle('is-active', shouldShow);
  stage.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
}

function updateRobotStage(stageEl, { label, message, active, stage } = {}) {
  if (!stageEl) return;
  if (typeof label === 'string') {
    const labelEl = stageEl.querySelector('.robot-stage-label');
    if (labelEl) labelEl.textContent = label;
  }
  if (typeof message === 'string') {
    const messageEl = stageEl.querySelector('.robot-stage-message');
    if (messageEl) messageEl.textContent = message;
  }
  if (stage) {
    stageEl.setAttribute('data-stage', sanitizeToken(stage));
  }
  if (typeof active === 'boolean') {
    stageEl.dataset.defaultActive = active ? 'true' : 'false';
    stageEl.classList.toggle('is-active', active);
    stageEl.setAttribute('aria-hidden', active ? 'false' : 'true');
  }
}

function normalizeExecutor(executor = {}) {
  return pruneEmpty({
    id: executor?.id || executor?.user_id || null,
    name: executor?.name || null,
    rank: executor?.rank || null,
    unit: executor?.unit || executor?.unit_name || null,
    phone: executor?.phone || executor?.phone_number || null
  }) || undefined;
}

function pruneEmpty(value) {
  if (Array.isArray(value)) {
    const arr = value
      .map((entry) => pruneEmpty(entry))
      .filter((entry) => {
        if (entry === undefined || entry === null) return false;
        if (typeof entry === "object" && !Array.isArray(entry) && !Object.keys(entry).length) return false;
        return true;
      });
    return arr.length ? arr : undefined;
  }

  if (value && typeof value === "object" && value.constructor === Object) {
    const obj = Object.entries(value).reduce((acc, [key, val]) => {
      const next = pruneEmpty(val);
      if (next !== undefined) {
        acc[key] = next;
      }
      return acc;
    }, {});
    return Object.keys(obj).length ? obj : undefined;
  }

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeSelector(value) {
  const str = String(value ?? "");
  if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
    return CSS.escape(str);
  }
  return str.replace(/(["'\\\[\]\.#])/g, "\\$1");
}

function sanitizeToken(value) {
  return (String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "pending");
}

function formatAmmoSummary(row) {
  if (!row) return "-";
  const items = getAmmoItems(row);
  if (items.length) {
    return items.map(formatAmmoLabel).join(", ") || "-";
  }
  if (row.ammo_summary) return row.ammo_summary;
  if (row.raw?.ammo_summary) return row.raw.ammo_summary;
  if (typeof row.ammo === "string") return row.ammo;
  if (typeof row.raw?.ammo === "string") return row.raw.ammo;
  return "-";
}

function renderAmmoList(row) {
  const items = getAmmoItems(row);
  if (!items.length) return "";
  const list = items.map((item) => `<li>${escapeHtml(formatAmmoLabel(item))}</li>`).join("");
  return `<ul class="ammo-list">${list}</ul>`;
}

function getAmmoItems(row) {
  if (!row) return [];
  if (Array.isArray(row.raw?.ammo_items) && row.raw.ammo_items.length) {
    return row.raw.ammo_items;
  }
  if (Array.isArray(row.ammo_items) && row.ammo_items.length) {
    return row.ammo_items;
  }
  return [];
}

function formatAmmoLabel(item = {}) {
  const name = item.caliber || item.type || item.name || item.code || item.label || "탄약";
  const qty = item.qty ?? item.quantity ?? item.count;
  const unit = item.unit || item.unit_label || item.measure || "";
  const parts = [name];
  if (qty !== undefined && qty !== null && qty !== "") {
    parts.push(`×${qty}`);
  }
  if (unit) parts.push(unit);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

