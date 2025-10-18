// assets/js/user.js
import { fetchMyPendingApprovals, executeRequest } from "./api.js";
import { getMe } from "./util.js";

export async function initUserMain() {
  const me = getMe();
  const list = document.getElementById("pending-list");
  list.innerHTML = `<div class="muted">불러오는 중…</div>`;
  try {
    const rows = await fetchMyPendingApprovals(me.id);
    if (!rows?.length) { list.innerHTML = `<div class="muted">집행 대기 건이 없습니다.</div>`; return; }
    list.innerHTML = rows.map(renderCard).join("");
    wire();
  } catch (e) {
    list.innerHTML = `<div class="error">${e.message}</div>`;
  }
}

function renderCard(r) {
  const id = r.id;
  const title = r.purpose ? `${r.purpose} #${id}` : `요청 #${id}`;
  return `
  <div class="item" data-toggle="${id}">
    <div class="row" style="justify-content:space-between"><b>${title}</b><span>${r.status||''}</span></div>
    <div class="details hidden" data-id="${id}" style="margin-top:8px">
      <div>종류: ${r.request_type || '-'}</div>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:8px">
        <button class="primary btn-exec" data-id="${id}">집행</button>
      </div>
    </div>
  </div>`;
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
