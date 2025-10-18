import { fetchMyPendingApprovals, executeRequest } from './api.js';
import { getMe } from './util.js';


export async function initUserMain(){
const me = getMe();
const list = document.getElementById('pending-list');
list.innerHTML = `<div class="muted">불러오는 중...</div>`;


try {
const rows = await fetchMyPendingApprovals(me.id);
if (!rows?.length) { list.innerHTML = `<div class="muted">집행 대기 건이 없습니다.</div>`; return; }
list.innerHTML = rows.map(renderCard).join('');
wire();
} catch(e){
list.innerHTML = `<div class="error">로딩 실패: ${e.message}</div>`;
}
}


function renderCard(row){
const rid = row.request_id ?? row.id;
const title = row.title ?? `${row.type || '요청'} #${rid}`;
const status = row.status || 'APPROVED';
return `
<div class="card">
<div class="head" data-toggle="${rid}">
<div class="title">${title}</div>
<div class="status">${status}</div>
</div>
<div class="details hidden" data-id="${rid}">
<div>종류: ${row.type || '-'}</div>
<div>무기/탄약 항목: ${row.items?.length ?? 0}건</div>
<div>신청자: ${row.requester_name || '-'}</div>
<div class="row end gap">
<button class="primary btn-exec" data-id="${rid}">집행</button>
</div>
</div>
</div>`;
}


function wire(){
document.querySelectorAll('.head').forEach(h=>{
h.addEventListener('click', ()=>{
const id = h.getAttribute('data-toggle');
document.querySelector(`.details[data-id="${id}"]`)?.classList.toggle('hidden');
});
});
document.querySelectorAll('.btn-exec').forEach(b=>{
b.addEventListener('click', async ()=>{
const id = b.getAttribute('data-id');
b.disabled = true; b.textContent = '집행중...';
try {
const me = getMe();
await executeRequest({ requestId:id, executorId: me.id });
b.textContent = '집행 완료';
setTimeout(()=> location.reload(), 500);
} catch(e){
alert('집행 실패: ' + e.message);
b.disabled = false; b.textContent = '집행';
}
});
});
}