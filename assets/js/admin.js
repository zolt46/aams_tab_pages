import { adminAction } from './api.js';


export function initAdminMain(){
const btnA = document.getElementById('btn-approvals');
const btnF = document.getElementById('btn-fp-mgmt');
const area = document.getElementById('admin-area');


btnA?.addEventListener('click', async ()=>{
area.innerHTML = renderApprovalListSkeleton();
// TODO: fetch list from backend, for now demo rows
const demo = [ {id:101, title:'요청 #101'}, {id:102, title:'요청 #102'} ];
area.querySelector('.list').innerHTML = demo.map(renderRow).join('');
wireAdminRowHandlers(area);
});


btnF?.addEventListener('click', ()=>{
area.innerHTML = `
<div class="card" style="padding:16px">
<h3>지문 관리(Placeholder)</h3>
<p class="muted">장비 연결 및 브릿지 API 준비 후 연동</p>
</div>`;
});
}


function renderApprovalListSkeleton(){
return `
<h3>승인/거부/재오픈</h3>
<div class="list"></div>
`;
}
function renderRow(r){
return `
<div class="card">
<div class="head" data-toggle="${r.id}">
<div class="title">${r.title}</div>
</div>
<div class="details hidden" data-id="${r.id}">
<div class="row end gap">
<button class="secondary" data-action="approve" data-request="${r.id}">승인</button>
<button class="secondary" data-action="reject" data-request="${r.id}">거부</button>
<button class="secondary" data-action="reopen" data-request="${r.id}">재오픈</button>
</div>
</div>
</div>`;
}
function wireAdminRowHandlers(root){
root.querySelectorAll('.head').forEach(h=>{
h.addEventListener('click', ()=>{
const id = h.getAttribute('data-toggle');
root.querySelector(`.details[data-id="${id}"]`)?.classList.toggle('hidden');
});
});
root.querySelectorAll('[data-action]').forEach(b=>{
b.addEventListener('click', async ()=>{
const action = b.getAttribute('data-action');
const requestId = b.getAttribute('data-request');
b.disabled = true;
try {
await adminAction({ requestId, action, actorId: 1 });
location.reload();
} catch(e){
alert(`${action} 실패: ` + e.message);
b.disabled = false;
}
});
});
}