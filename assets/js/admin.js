import { adminAction, fetchAdminPending } from "./api.js"; // (동일, 이제 실제로 존재함)
import { mountMobileHeader } from "./util.js";


export async function initAdminMain(){
await mountMobileHeader({ title: "관리자", pageType: "main", showLogout: true });
const btnA = document.getElementById('btn-approvals');
const area = document.getElementById('admin-area');
btnA?.addEventListener('click', async ()=>{
area.innerHTML = `<h3>승인/거부/재오픈</h3><div class="list" id="ap-list"></div>`;
const list = document.getElementById('ap-list');
list.innerHTML = `<div class="muted">불러오는 중…</div>`;
try {
  const rows = await fetchAdminPending({ limit: 30 });
  rows.sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
  list.innerHTML = rows.map(renderCard).join("");
  wire(list);
} catch(e) {
  list.innerHTML = `<div class="error">${e.message}</div>`;
}
wire(list);
});
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


function row(r){
return `<div class="item">
<div class="row" style="justify-content:space-between"><b>${r.title}</b></div>
<div class="row" style="justify-content:flex-end;gap:8px;margin-top:8px">
<button class="secondary" data-act="approve" data-id="${r.id}">승인</button>
<button class="secondary" data-act="reject" data-id="${r.id}">거부</button>
<button class="secondary" data-act="reopen" data-id="${r.id}">재오픈</button>
</div>
</div>`;
}


function wire(root){
root.querySelectorAll('[data-act]').forEach(b=>{
b.addEventListener('click', async ()=>{
const action = b.getAttribute('data-act');
const requestId = b.getAttribute('data-id');
b.disabled = true;
try { await adminAction({ requestId, action, actorId: 1 }); location.reload(); }
catch(e){ alert(`${action} 실패: `+e.message); b.disabled=false; }
});
});
}