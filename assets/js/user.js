// assets/js/user.js
import { fetchMyPendingApprovals as fetchUserPending, executeRequest } from "./api.js";
import { getMe, renderMeBrief, mountMobileHeader } from "./util.js";

const numberFormatter = new Intl.NumberFormat("ko-KR");

function getLatestApprovalTimestamp(row = {}) {
  return row?.approved_at
    || row?.updated_at
    || row?.raw?.approved_at
    || row?.raw?.updated_at
    || row?.raw?.request?.approved_at
    || row?.raw?.request?.updated_at
    || row?.created_at
    || row?.requested_at;
}

export async function initUserMain() {
  await mountMobileHeader({ title: "사용자", pageType: "main", showLogout: true });

  const me = getMe();
  renderMeBrief(me);
  const greetingEl = document.getElementById("user-hub-greeting");
  if (greetingEl) {
    greetingEl.innerHTML = renderHeroGreeting(me);
  }


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
    rows.sort((a, b) => new Date(getLatestApprovalTimestamp(b) || 0) - new Date(getLatestApprovalTimestamp(a) || 0));

    if (toggleBtn) toggleBtn.disabled = !rows.length;

    updateDashboardStats({
      pendingCount: rows.length,
      latest: rows.length ? formatKST(getLatestApprovalTimestamp(rows[0])) : "-"
    });

    if (!rows?.length) {
      list.innerHTML = `<div class="muted">집행 대기 건이 없습니다.</div>`;
      return;
    }

    list.innerHTML = rows.map(renderCard).join("");
    wire();
  } catch (e) {
    const message = escapeHtml(e?.message || "오류가 발생했습니다.");
    list.innerHTML = `<div class="error">불러오기 실패: ${message}</div>`;
    updateDashboardStats({ pendingCount: "-", latest: "-" });
    if (toggleBtn) toggleBtn.disabled = false;
  }
}

function renderCard(r) {
  const requestId = r?.id ?? r?.raw?.id ?? "";
  const idValue = String(requestId ?? "");
  const idLabel = idValue ? `REQ-${idValue.padStart(4, "0")}` : "REQ----";
  const typeText = r.type === "ISSUE" ? "불출" : (r.type === "RETURN" ? "불입" : (r.type || "요청"));
  const requestedAt = formatKST(r.requested_at || r.created_at) || "-";
  const approvedAt = formatKST(getLatestApprovalTimestamp(r)) || "-";
  const statusLabel = r.status ?? "대기";
  const statusClass = `status-${sanitizeToken(r.status || "pending")}`;
  const ammoSummary = formatAmmoSummary(r);
  const requester = r.requester_name ?? r.raw?.requester_name ?? r.raw?.requester?.name ?? "-";
  const weaponCode = r.weapon_code ?? r.weapon?.code ?? r.raw?.weapon_code ?? r.raw?.weapon?.code ?? "-";

  return `
    <article class="card pending-card" data-id="${escapeHtml(requestId)}">
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
      </div>
      <footer class="card-actions">
        <button class="btn primary" data-act="execute" data-id="${escapeHtml(requestId)}">
          <span class="btn-label">집행</span>
        </button>
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
  if (pendingEl) pendingEl.textContent = formatCount(pendingCount);

  const latestEl = document.getElementById("latest-request");
  if (latestEl) latestEl.textContent = latest && latest !== "-" ? latest : "-";
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
