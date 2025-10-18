import { adminAction, fetchAdminPending } from "./api.js";
import { getMe, mountMobileHeader, renderMeBrief } from "./util.js";

export async function initAdminMain() {
  try {
    await mountMobileHeader({ title: "관리자", pageType: "main", showLogout: true });

    const me = getMe();
    renderMeBrief(me);
    adaptStatLabels();

    const list = document.getElementById("pending-list");
    const refreshBtn = document.getElementById("pending-refresh");

    if (!list) {
      console.error("[AAMS][admin] pending list container가 없습니다.");
      return;
    }

    let isLoading = false;

    const setRefreshState = (busy) => {
      if (!refreshBtn) return;
      refreshBtn.disabled = busy;
      refreshBtn.textContent = busy ? "새로고침중…" : "새로고침";
    };

    const load = async ({ silent } = {}) => {
      if (isLoading) return;
      isLoading = true;
      setRefreshState(true);

      if (!silent) {
        list.innerHTML = `<div class="muted">불러오는 중…</div>`;
        updateAdminStats({ pendingCount: "-", latest: "-" });
      }

      try {
        const rows = (await fetchAdminPending({ limit: 50 })) || [];
        rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        updateAdminStats({
          pendingCount: rows.length,
          latest: rows.length ? formatKST(rows[0]?.created_at) : "-"
        });

        if (!rows.length) {
          list.innerHTML = `<div class="muted">승인 대기 건이 없습니다.</div>`;
          return;
        }

        list.innerHTML = rows.map(renderCard).join("");
        wire(list, me);
      } catch (error) {
        const message = escapeHtml(error?.message || "불러오기 실패");
        list.innerHTML = `<div class="error">불러오기 실패: ${message}</div>`;
        updateAdminStats({ pendingCount: "-", latest: "-" });
      } finally {
        isLoading = false;
        setRefreshState(false);
      }
    };

    refreshBtn?.addEventListener("click", () => load({ silent: false }));

    await load({ silent: false });
  } catch (error) {
    console.error("[AAMS][admin] 관리자 메인 초기화 실패", error);
    showAdminInitError(error);
  }
}

function adaptStatLabels() {
  const labels = document.querySelectorAll("#me-brief .stat-card .label");
  if (labels[0]) labels[0].textContent = "승인 대기";
  if (labels[1]) labels[1].textContent = "최근 접수";
}

function renderCard(r) {
  const escape = escapeHtml;
  const idLabel = `REQ-${String(r.id).padStart(4, "0")}`;
  const typeText = r.type === "ISSUE" ? "불출" : (r.type === "RETURN" ? "불입" : (r.type || "요청"));
  const statusText = formatStatus(r.status);
  const statusClass = `status-${(r.status || "pending").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const when = formatKST(r.created_at) || "-";
  return `
    <article class="card pending-card admin-card" data-id="${escape(r.id)}">
      <header class="card-header">
        <div class="card-title">
          <span class="chip">${escape(idLabel)}</span>
          <span class="chip">${escape(typeText)}</span>
        </div>
        <span class="badge ${statusClass}">${escape(statusText)}</span>
      </header>
      <div class="card-summary">
        <div class="summary-item">
          <span class="label">총기</span>
          <span class="value">${escape(r.weapon_code ?? "-")}</span>
        </div>
        <div class="summary-item">
          <span class="label">탄약</span>
          <span class="value">${escape(r.ammo_summary ?? "-")}</span>
        </div>
        <div class="summary-item">
          <span class="label">신청자</span>
          <span class="value">${escape(r.requester_name ?? "-")}</span>
        </div>
        <div class="summary-item">
          <span class="label">요청 시간</span>
          <span class="value">${escape(when)}</span>
        </div>
      </div>
      <footer class="card-actions">
        <button class="btn primary" data-act="approve" data-id="${escape(r.id)}">
          <span class="btn-label">승인</span>
        </button>
        <button class="btn danger" data-act="reject" data-id="${escape(r.id)}">
          <span class="btn-label">거부</span>
        </button>
        <button class="btn ghost detail-btn" data-act="detail" data-id="${escape(r.id)}" aria-expanded="false">
          <span class="btn-label">상세 보기</span>
          <span class="chevron">⌄</span>
        </button>
      </footer>
      <div class="card-detail hidden" data-id="${escape(r.id)}">
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
            <span class="term">신청자</span>
            <span class="desc">${escape(r.requester_name ?? "-")}</span>
          </div>
          <div>
            <span class="term">요청 시간</span>
            <span class="desc">${escape(when)}</span>
          </div>
          <div>
            <span class="term">총기</span>
            <span class="desc">${escape(r.weapon_code ?? "-")}</span>
          </div>
          <div>
            <span class="term">탄약</span>
            <span class="desc">${escape(r.ammo_summary ?? "-")}</span>
          </div>
        </div>
      </div>
    </article>`;
}

function wire(root, me) {
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

  root.querySelectorAll('[data-act="approve"],[data-act="reject"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-act");
      const requestId = btn.getAttribute("data-id");
      if (!requestId || !action) return;

      let reason = "";
      if (action === "reject") {
        const input = prompt("거부 사유를 입력하세요.");
        if (input === null) return; // 취소
        reason = input.trim();
      }

      const label = btn.querySelector(".btn-label");
      const original = label ? label.textContent : btn.textContent;
      btn.disabled = true;
      if (label) label.textContent = action === "approve" ? "승인중…" : "거부중…";
      else btn.textContent = action === "approve" ? "승인중…" : "거부중…";

      try {
        await adminAction({ requestId, action, actorId: me?.id ?? 1, reason });
        if (label) label.textContent = "완료"; else btn.textContent = "완료";
        setTimeout(() => location.reload(), 600);
      } catch (error) {
        console.error(`[AAMS][admin] ${action} 실패`, error);
        alert(`${action === "approve" ? "승인" : "거부"} 실패: ${error?.message || error}`);
        btn.disabled = false;
        if (label) label.textContent = original; else btn.textContent = original;
      }
    });
  });
}

function showAdminInitError(error) {
  const list = document.getElementById("pending-list");
  const app = document.getElementById("app");
  const message = escapeHtml(error?.message || error || "알 수 없는 오류");

  if (list) {
    list.innerHTML = `<div class="error">관리자 화면 초기화 실패: ${message}</div>`;
    return;
  }

  const container = document.createElement("div");
  container.className = "error";
  container.textContent = `관리자 화면 초기화 실패: ${message}`;
  app?.appendChild(container);
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
    EXECUTED: "집행 완료"
  };
  if (!status) return "대기";
  return map[status] || status;
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
  return raw.replace(/['"\\]/g, "\\$&").replace(/\s+/g, (segment) => segment.split("").map((ch) => `\\${ch}`).join(""));
}