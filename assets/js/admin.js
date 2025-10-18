import {
  adminAction,
  fetchAdminRequestOverview,
  fetchDashboardSummary,
  fetchPersonnelById
} from "./api.js";
import { getMe, mountMobileHeader, renderMeBrief, saveMe } from "./util.js";

const state = {
  me: null,
  filter: "pending",
  requests: [],
  counts: {
    pending: 0,
    approved: 0,
    rejected: 0,
    executed: 0,
    cancelled: 0,
    other: 0,
    total: 0
  }
};

let listEl;
let refreshBtn;
let summaryEl;
let overviewEl;
let filterWrap;
let isLoadingRequests = false;

export async function initAdminMain() {
  try {
    await mountMobileHeader({ title: "관리자 홈", pageType: "main", showLogout: true });

    listEl = null;
    refreshBtn = null;
    summaryEl = null;
    overviewEl = null;
    filterWrap = null;
    isLoadingRequests = false;

    const greetingEl = document.getElementById("admin-hub-greeting");
    const me = await ensureAdminProfile();
    if (greetingEl) {
      greetingEl.innerHTML = renderHubGreeting(me);
    }
  } catch (error) {
    console.error("[AAMS][admin] 관리자 홈 초기화 실패", error);
    showAdminInitError(error);
  }
}

export async function initAdminSummary() {
  try {
    await mountMobileHeader({
      title: "관리자 요약",
      pageType: "subpage",
      showLogout: true,
      backTo: "#/admin",
      homeTo: "#/admin"
    });

    listEl = null;
    refreshBtn = null;
    overviewEl = null;
    filterWrap = null;
    isLoadingRequests = false;
    summaryEl = document.getElementById("admin-stats");

    const me = await ensureAdminProfile();
    renderMeBrief(me);
    adaptStatLabels();

    await loadSummary();
  } catch (error) {
    console.error("[AAMS][admin] 관리자 요약 초기화 실패", error);
    showAdminInitError(error);
  }
}

export async function initAdminRequests() {
  try {
    await mountMobileHeader({
      title: "신청 현황",
      pageType: "subpage",
      showLogout: true,
      backTo: "#/admin",
      homeTo: "#/admin"
    });

    listEl = document.getElementById("requests-list");
    refreshBtn = document.getElementById("requests-refresh");
    overviewEl = document.getElementById("request-overview");
    filterWrap = document.getElementById("request-filters");
    summaryEl = null;
    isLoadingRequests = false;

    if (!listEl) {
      console.error("[AAMS][admin] 요청 리스트 컨테이너가 없습니다.");
      return;
    }

    const me = await ensureAdminProfile();
    renderMeBrief(me);
    adaptStatLabels();

    state.filter = "pending";
    wireFilters();
    refreshBtn?.addEventListener("click", () => loadRequests({ silent: false }));

    await loadRequests({ silent: false });
  } catch (error) {
    console.error("[AAMS][admin] 신청 현황 초기화 실패", error);
    showAdminInitError(error);
  }
}

async function ensureAdminProfile() {
  if (state.me?.id) {
    return state.me;
  }
  let me = getMe();
  me = await hydrateAdmin(me);
  state.me = me;
  return me;
}


async function hydrateAdmin(me = {}) {
  if (!me?.id) return me;
  const needsDetail = !me.rank || !me.unit || !me.contact || !me.serial;
  if (!needsDetail) return me;
  try {
    const full = await fetchPersonnelById(me.id);
    const enriched = {
      ...me,
      rank: full?.rank ?? me.rank,
      unit: full?.unit ?? me.unit,
      serial: full?.military_id ?? me.serial,
      military_id: full?.military_id ?? me.military_id,
      contact: full?.contact ?? me.contact,
      position: full?.position ?? me.position,
      duty: full?.position ?? me.duty
    };
    saveMe(enriched);
    return enriched;
  } catch (error) {
    console.warn("[AAMS][admin] 관리자 상세 정보 불러오기 실패", error);
    return me;
  }
}


function adaptStatLabels() {
  const labels = document.querySelectorAll("#me-brief .stat-card .label");
  if (labels[0]) labels[0].textContent = "승인 대기";
  if (labels[1]) labels[1].textContent = "최근 처리";
}

function wireFilters() {
  if (!filterWrap) return;
  filterWrap.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    const filter = btn.getAttribute("data-filter");
    if (!filter || state.filter === filter) return;
    state.filter = filter;
    updateFilterActive();
    renderRequestList();
  });
  updateFilterActive();
}

function updateFilterActive() {
  if (!filterWrap) return;
  filterWrap.querySelectorAll("[data-filter]").forEach((btn) => {
    const value = btn.getAttribute("data-filter");
    const isActive = value === state.filter;
    btn.classList.toggle("is-active", isActive);
    if (btn.hasAttribute("aria-selected")) {
      btn.setAttribute("aria-selected", String(isActive));
    }
  });
}

async function loadSummary() {
  if (!summaryEl) return;
  summaryEl.innerHTML = `<div class="muted">지표 불러오는 중…</div>`;
  try {
    const data = await fetchDashboardSummary();
    summaryEl.innerHTML = renderSummaryCards(data);
    updateAdminStats({ pendingCount: fmtNumber(data?.pending || 0), latest: "-" });
  } catch (error) {
    console.error("[AAMS][admin] 요약 불러오기 실패", error);
    summaryEl.innerHTML = `<div class="error">요약 정보를 불러오지 못했습니다.</div>`;
  }
}

async function loadRequests({ silent } = {}) {
  if (isLoadingRequests) return;
  isLoadingRequests = true;
  setRefreshState(true);

  if (!silent && listEl) {
    listEl.innerHTML = `<div class="muted">요청 정보를 불러오는 중…</div>`;
  }

  try {
    const { rows, counts, latestSubmitted } = await fetchAdminRequestOverview({ limit: 80 });
    rows.sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0));
    state.requests = rows;
    state.counts = counts;

    renderCounts(counts);
    updateFilterActive();
    renderRequestList();

    updateAdminStats({
      pendingCount: counts.pending,
      latest: latestSubmitted ? formatKST(latestSubmitted) : "-"
    });
  } catch (error) {
    console.error("[AAMS][admin] 요청 현황 불러오기 실패", error);
    const message = escapeHtml(error?.message || error || "불러오기 실패");
    if (listEl) {
      listEl.innerHTML = `<div class="error">요청 목록을 불러오지 못했습니다: ${message}</div>`;
    }
    renderCounts({ pending: 0, approved: 0, rejected: 0, executed: 0, cancelled: 0, other: 0, total: 0 });
    updateAdminStats({ pendingCount: "-", latest: "-" });
  } finally {
    isLoadingRequests = false;
    setRefreshState(false);
  }
}

function renderCounts(counts) {
  const targets = {
    pending: document.getElementById("count-pending"),
    approved: document.getElementById("count-approved"),
    rejected: document.getElementById("count-rejected"),
    executed: document.getElementById("count-executed"),
    cancelled: document.getElementById("count-cancelled"),
    all: document.getElementById("count-all")
  };

  if (targets.pending) targets.pending.textContent = fmtNumber(counts?.pending || 0);
  if (targets.approved) targets.approved.textContent = fmtNumber(counts?.approved || 0);
  if (targets.rejected) targets.rejected.textContent = fmtNumber(counts?.rejected || 0);
  if (targets.executed) targets.executed.textContent = fmtNumber(counts?.executed || 0);
  if (targets.cancelled) targets.cancelled.textContent = fmtNumber(counts?.cancelled || 0);
  if (targets.all) targets.all.textContent = fmtNumber(counts?.total || 0);

  if (!overviewEl) return;
  overviewEl.innerHTML = `
    <div class="overview-grid">
      <div class="overview-chip warn">⏳ 대기 ${fmtNumber(counts?.pending || 0)}</div>
      <div class="overview-chip ok">✅ 승인 ${fmtNumber(counts?.approved || 0)}</div>
      <div class="overview-chip err">❌ 거부 ${fmtNumber(counts?.rejected || 0)}</div>
      <div class="overview-chip info">📦 집행 ${fmtNumber(counts?.executed || 0)}</div>
      <div class="overview-chip muted">⛔ 취소 ${fmtNumber(counts?.cancelled || 0)}</div>
      <div class="overview-chip neutral">📊 전체 ${fmtNumber(counts?.total || 0)}</div>
    </div>
  `;
}

function renderRequestList() {
  if (!listEl) return;
  const filtered = state.requests.filter((row) => matchesFilter(row, state.filter));
  if (!filtered.length) {
    listEl.innerHTML = `<div class="muted">해당 조건의 신청이 없습니다.</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(renderRequestCard).join("");
  wireActions(listEl);
}

function renderRequestCard(row) {
  const escape = escapeHtml;
  const idLabel = `REQ-${String(row.id ?? "").padStart(4, "0")}`;
  const typeText = formatType(row.type);
  const statusText = formatStatus(row.status);
  const statusClass = formatStatusClass(row.status);
  const requestedAt = formatKST(row.created_at) || "-";
  const updatedAt = formatKST(row.updated_at) || "-";
  const scheduledAt = formatKST(row.scheduled_at) || "-";
  const purpose = row.purpose ? escape(row.purpose) : "-";
  const location = row.location ? escape(row.location) : "-";
  const statusReason = row.status_reason ? escape(row.status_reason) : "-";

  const canDecide = ["SUBMITTED", "PENDING", "WAITING", "REQUESTED"].includes(row.status);
  const canReopen = ["APPROVED", "REJECTED", "CANCELLED"].includes(row.status);

  const actions = [];
  if (canDecide) {
    actions.push(`
      <button class="btn primary" data-act="approve" data-id="${escape(row.id)}">
        <span class="btn-label">승인</span>
      </button>
    `);
    actions.push(`
      <button class="btn danger" data-act="reject" data-id="${escape(row.id)}">
        <span class="btn-label">거부</span>
      </button>
    `);
  } else if (canReopen) {
    actions.push(`
      <button class="btn secondary" data-act="reopen" data-id="${escape(row.id)}">
        <span class="btn-label">재오픈</span>
      </button>
    `);
  }

  actions.push(`
    <button class="btn ghost detail-btn" data-act="detail" data-id="${escape(row.id)}" aria-expanded="false">
      <span class="btn-label">상세 보기</span>
      <span class="chevron">⌄</span>
    </button>
  `);
  return `
    <article class="card pending-card admin-card request-card" data-id="${escape(row.id)}">
      <header class="card-header">
        <div class="card-title">
          <span class="chip">${escape(idLabel)}</span>
          <span class="chip">${escape(typeText)}</span>
        </div>
        <span class="badge ${statusClass}">${escape(statusText)}</span>
      </header>
      <div class="card-summary">
        <div class="summary-item">
          <span class="label">신청자</span>
          <span class="value">${escape(row.requester_name ?? "-")}</span>
        </div>
        <div class="summary-item">
          <span class="label">요청 시간</span>
          <span class="value">${escape(requestedAt)}</span>
        </div>
        <div class="summary-item">
          <span class="label">예정/집행</span>
          <span class="value">${escape(scheduledAt)}</span>
        </div>
        <div class="summary-item">
          <span class="label">최근 갱신</span>
          <span class="value">${escape(updatedAt)}</span>
        </div>
      </div>
      <footer class="card-actions">
        ${actions.join("")}
      </footer>
      <div class="card-detail hidden" data-id="${escape(row.id)}">
        <div class="detail-grid">
          <div>
            <span class="term">요청 유형</span>
            <span class="desc">${escape(typeText)}</span>
          </div>
          <div>
            <span class="term">상태</span>
            <span class="desc">${escape(statusText)}</span>
          </div>
          <div>
            <span class="term">총기</span>
            <span class="desc">${escape(row.weapon_code ?? "-")}</span>
          </div>
          <div>
            <span class="term">탄약</span>
            <span class="desc">${escape(row.ammo_summary ?? "-")}</span>
          </div>
          <div>
            <span class="term">목적</span>
            <span class="desc">${purpose}</span>
          </div>
          <div>
            <span class="term">장소</span>
            <span class="desc">${location}</span>
          </div>
          <div>
            <span class="term">상태 메모</span>
            <span class="desc">${statusReason}</span>
          </div>
        </div>
      </div>
    </article>
  `;
}

function matchesFilter(row, filter) {
  switch (filter) {
    case "pending":
      return ["SUBMITTED", "PENDING", "WAITING", "REQUESTED"].includes(row.status);
    case "approved":
      return row.status === "APPROVED";
    case "rejected":
      return row.status === "REJECTED";
    case "executed":
      return row.status === "EXECUTED";
    case "cancelled":
      return row.status === "CANCELLED";
    case "all":
      return true;
    default:
      return true;
  }
}

function wireActions(root) {
  root.querySelectorAll('[data-act="detail"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      const detail = root.querySelector(`.card-detail[data-id="${escapeSelector(id)}"]`);
      if (!detail) return;
      const isHidden = detail.classList.toggle("hidden");
      const expanded = !isHidden;
      btn.setAttribute("aria-expanded", String(expanded));
      btn.classList.toggle("is-open", expanded);
      const label = btn.querySelector(".btn-label");
      if (label) label.textContent = expanded ? "상세 닫기" : "상세 보기";
    });
  });

  root.querySelectorAll('[data-act="approve"],[data-act="reject"],[data-act="reopen"]').forEach((btn) => {
    btn.addEventListener("click", () => handleAction(btn));
  });
}

async function handleAction(btn) {
  const action = btn.getAttribute("data-act");
  const requestId = btn.getAttribute("data-id");
  if (!action || !requestId) return;

  let reason = "";
  if (action === "reject") {
    const input = prompt("거부 사유를 입력하세요.");
    if (input === null) return; // 취소
    reason = input.trim();
  }

  const label = btn.querySelector(".btn-label");
  const original = label ? label.textContent : btn.textContent;
  btn.disabled = true;
  if (label) {
    label.textContent = action === "approve" ? "승인중…" : action === "reject" ? "거부중…" : "재오픈중…";
  } else {
    btn.textContent = action === "approve" ? "승인중…" : action === "reject" ? "거부중…" : "재오픈중…";
  }

  try {
    await adminAction({ requestId, action, actorId: state.me?.id ?? 1, reason });
    await loadRequests({ silent: true });
  } catch (error) {
    console.error(`[AAMS][admin] ${action} 실패`, error);
    alert(`${action === "approve" ? "승인" : action === "reject" ? "거부" : "재오픈"} 실패: ${error?.message || error}`);
  } finally {
    btn.disabled = false;
    if (label) label.textContent = original ?? "";
    else if (original) btn.textContent = original;
  }
}

function showAdminInitError(error) {

  const message = escapeHtml(error?.message || error || "알 수 없는 오류");
  if (listEl) {
    listEl.innerHTML = `<div class="error">관리자 화면 초기화 실패: ${message}</div>`;
  }
  const container = document.createElement("div");
  container.className = "error";
  container.textContent = `관리자 화면 초기화 실패: ${message}`;
  document.getElementById("app")?.appendChild(container);
}


function updateAdminStats({ pendingCount = "-", latest = "-" } = {}) {
  const pendingEl = document.getElementById("pending-count");
  if (pendingEl) pendingEl.textContent = pendingCount;

  const latestEl = document.getElementById("latest-request");
  if (latestEl) latestEl.textContent = latest;
}

function formatStatus(status) {
  const map = {
    SUBMITTED: "접수됨",
    PENDING: "대기",
    WAITING: "대기",
    REQUESTED: "요청됨",
    APPROVED: "승인됨",
    REJECTED: "거부됨",
    EXECUTED: "집행 완료",
    CANCELLED: "취소됨"
  };
  if (!status) return "대기";
  return map[status] || status;
}

function formatStatusClass(status) {
  return `status-${String(status || "pending").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function formatType(type) {
  const map = {
    ISSUE: "불출",
    DISPATCH: "불출",
    RETURN: "불입",
    INCOMING: "불입"
  };
  if (!type) return "요청";
  return map[type] || type;
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeSelector(value) {
  const raw = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(raw);
  }
  return raw
    .replace(/['"\\]/g, "\\$&")
    .replace(/\s+/g, (segment) => segment.split("").map((ch) => `\\${ch}`).join(""));
}

function fmtNumber(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return String(value ?? 0);
  return num.toLocaleString("ko-KR");
}

function setRefreshState(busy) {
  if (!refreshBtn) return;
  refreshBtn.disabled = busy;
  refreshBtn.textContent = busy ? "새로고침중…" : "새로고침";
}

function renderSummaryCards(data = {}) {
  const fmt = fmtNumber;
  return `
    <div class="metric-grid">
      <article class="metric-card">
        <div class="metric-label"><span class="icon">👥</span>전체 인원</div>
        <div class="metric-value">${fmt(data.person || 0)}</div>
        <div class="metric-sub">관리자 ${fmt(data.admins || 0)}명</div>
      </article>
      <article class="metric-card">
        <div class="metric-label"><span class="icon">🛡️</span>운영 상태</div>
        <div class="metric-value">${fmt(data.firearm || 0)}</div>
        <div class="metric-sub">불입 ${fmt(data.inDepot || 0)} · 불출 ${fmt(data.deployed || 0)}</div>
      </article>
      <article class="metric-card">
        <div class="metric-label"><span class="icon">📦</span>탄약 품목</div>
        <div class="metric-value">${fmt(data.ammo || 0)}</div>
        <div class="metric-sub">총 재고 ${fmt(data.totalAmmoQty || 0)} · 저수량 ${fmt(data.lowAmmo || 0)}</div>
      </article>
      <article class="metric-card">
        <div class="metric-label"><span class="icon">⏳</span>승인 대기</div>
        <div class="metric-value">${fmt(data.pending || 0)}</div>
        <div class="metric-sub">접수 대기 중인 요청 수</div>
      </article>
    </div>
  `;
}

function renderHubGreeting(me = {}) {
  if (!me?.id) {
    return `<div class="muted">계정 정보를 불러오지 못했습니다.</div>`;
  }

  const name = [me.rank, me.name].filter(Boolean).join(" ") || "관리자";
  const unit = me.unit || me.unit_name || "-";
  const escape = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return `
    <p class="hub-greeting-text"><strong>${escape(name)}</strong>님, 환영합니다.</p>
    <p class="hub-greeting-sub">현재 소속: ${escape(unit || "-")}</p>
  `;
}
