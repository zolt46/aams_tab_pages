// assets/js/user.js
import { fetchMyPendingApprovals as fetchUserPending, executeRequest } from "./api.js";
import { getMe, renderMeBrief, mountMobileHeader } from "./util.js";

export async function initUserMain() {
  await mountMobileHeader({ title: "사용자", pageType: "main", showLogout: true });

  const me = getMe();
  renderMeBrief(me);

  const list = document.getElementById("pending-list");
  const toggleBtn = document.getElementById("pending-toggle");

  const setCollapsed = (collapsed) => {
    if (!list) return;
    list.classList.toggle("collapsed", collapsed);
    if (toggleBtn) {
      toggleBtn.textContent = collapsed ? "펼치기" : "접기";
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    }
  };

  setCollapsed(false);

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const current = list?.classList.contains("collapsed");
      setCollapsed(!current);
    });
  }

  if (!list) return;

  updateDashboardStats({ pendingCount: "-", latest: "-" });

  if (toggleBtn) toggleBtn.disabled = true;

  if (!me?.id) {
    list.innerHTML = `<div class="error">사용자 정보를 확인할 수 없습니다.</div>`;
    return;
  }

  list.innerHTML = `<div class="muted">불러오는 중…</div>`;

  try {
    const rows = await fetchUserPending(me.id) || [];
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (toggleBtn) toggleBtn.disabled = !rows.length;

    updateDashboardStats({
      pendingCount: rows.length,
      latest: rows.length ? formatKST(rows[0]?.created_at) : "-"
    });

    if (!rows?.length) {
      list.innerHTML = `<div class="muted">집행 대기 건이 없습니다.</div>`;
      return;
    }

    list.innerHTML = rows.map(renderCard).join("");
    wire();
  } catch (e) {
    list.innerHTML = `<div class="error">불러오기 실패: ${e.message}</div>`;
    updateDashboardStats({ pendingCount: "-", latest: "-" });
    if (toggleBtn) toggleBtn.disabled = false;
  }
}

function renderCard(r) {
  const escape = (value) => String(value ?? "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const idLabel = `REQ-${String(r.id).padStart(4, "0")}`;
  const typeText = r.type === "ISSUE" ? "불출" : (r.type === "RETURN" ? "불입" : (r.type || "요청"));
  const when = formatKST(r.created_at) || "-";
  const statusText = escape(r.status ?? "대기");
  const statusClass = `status-${(r.status || "pending").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return `
    <article class="card pending-card" data-id="${escape(r.id)}">
      <header class="card-header">
        <div class="card-title">
          <span class="chip">${escape(idLabel)}</span>
          <span class="chip">${escape(typeText)}</span>
        </div>
        <span class="badge ${statusClass}">${statusText}</span>
      </header>
      <div class="card-summary">
        <div class="summary-item">
          <span class="label">총기</span>
          <span class="value">${escape(r.weapon_code ?? r.weapon?.code ?? "-")}</span>
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
        <button class="btn primary" data-act="execute" data-id="${escape(r.id)}">
          <span class="btn-label">집행</span>
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
            <span class="desc">${statusText}</span>
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
            <span class="desc">${escape(r.weapon_code ?? r.weapon?.code ?? "-")}</span>
          </div>
          <div>
            <span class="term">탄약</span>
            <span class="desc">${escape(r.ammo_summary ?? "-")}</span>
          </div>
        </div>
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

function wire() {
  document.querySelectorAll('[data-act="detail"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const detail = document.querySelector(`.card-detail[data-id="${id}"]`);
      if (!detail) return;
      const isHidden = detail.classList.toggle("hidden");
      const expanded = !isHidden;
      btn.setAttribute("aria-expanded", String(expanded));
      btn.classList.toggle("is-open", expanded);
      const label = btn.querySelector(".btn-label");
      if (label) label.textContent = expanded ? "상세 닫기" : "상세 보기";
    });
  });

  document.querySelectorAll('[data-act="execute"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const label = btn.querySelector(".btn-label");
      const original = label ? label.textContent : btn.textContent;
      const requestId = Number(btn.getAttribute("data-id"));
      if (!requestId) return;
      btn.disabled = true;
      if (label) label.textContent = "집행중…"; else btn.textContent = "집행중…";

      try {
        const me = getMe();
        await executeRequest({ requestId, executorId: me?.id });
        if (label) label.textContent = "완료"; else btn.textContent = "완료";
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        alert(`집행 실패: ${e.message}`);
        btn.disabled = false;
        if (label) label.textContent = original; else btn.textContent = original;
      }
    });
  });
}

function updateDashboardStats({ pendingCount = "-", latest = "-" } = {}) {
  const pendingEl = document.getElementById("pending-count");
  if (pendingEl) pendingEl.textContent = pendingCount;

  const latestEl = document.getElementById("latest-request");
  if (latestEl) latestEl.textContent = latest;
}
