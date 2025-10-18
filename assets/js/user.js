// assets/js/user.js
import { fetchMyPendingApprovals as fetchUserPending, executeRequest } from "./api.js";
import { getMe, renderMeBrief, mountMobileHeader } from "./util.js";

export async function initUserMain() {
    // ⬇⬇ 상단 헤더 장착 (메인 페이지)
  await mountMobileHeader({ title: "사용자", pageType: "main", showLogout: true });
  // 내 정보 요약
  renderMeBrief(getMe());
  const me = getMe();
  const list = document.getElementById("pending-list");
  list.innerHTML = `<div class="muted">불러오는 중…</div>`;
  try {
    const rows = await fetchUserPending(me.id);
    // 최신순 정렬(서버가 정렬 보장하지 않는 경우 대비)
    rows.sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
    const last3 = rows.slice(0,3);
    if (!rows?.length) { list.innerHTML = `<div class="muted">집행 대기 건이 없습니다.</div>`; return; }
    list.innerHTML = rows.map(renderCard).join("");
    wire();
  } catch (e) {
    list.innerHTML = `<div class="error">${e.message}</div>`;
  }
}

function renderCard(r){
  // r: { id, type, status, weapon_code, ammo_summary, requester_name, created_at }
  const typeText = r.type === "ISSUE" ? "불출" : (r.type === "RETURN" ? "불입" : r.type || "요청");
  const when = formatKST(r.created_at); // 아래 유틸 참고
  return `
    <div class="card">
      <div class="row">
        <h3>[REQ-${String(r.id).padStart(4,"0")}] ${typeText}</h3>
        <span class="badge">${r.status ?? "대기"}</span>
      </div>
      <div class="meta">
        <span>총기: ${r.weapon_code ?? "-"}</span>
        <span>탄약: ${r.ammo_summary ?? "-"}</span>
        <span>신청자: ${r.requester_name ?? "-"}</span>
        <span>${when}</span>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn primary sm" data-act="approve" data-id="${r.id}">승인</button>
        <button class="btn ghost sm" data-act="reject" data-id="${r.id}">거부</button>
        <button class="btn ghost sm" data-act="detail" data-id="${r.id}">상세</button>
      </div>
    </div>`;
}

function formatKST(ts){
  if(!ts) return "";
  const d = new Date(ts);
 const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function wire() {
  document.querySelectorAll("[data-toggle]").forEach(h=>{
    h.addEventListener("click", ()=>{
      const id = h.getAttribute("data-toggle");
      document.querySelector(`.details[data-id="${id}"]`)?.classList.toggle("hidden");
    });
  });
  document.querySelectorAll(".btn-exec").forEach(b=>{
    b.addEventListener("click", async ()=>{
      const id = b.getAttribute("data-id");
      b.disabled = true; b.textContent = "집행중…";
      try {
        const me = getMe();
        await executeRequest({ requestId: id, executorId: me.id });
        b.textContent = "집행 완료";
        setTimeout(()=> location.reload(), 500);
      } catch (e) {
        alert("집행 실패: " + e.message);
        b.disabled = false; b.textContent = "집행";
      }
    });
  });
}
