import { adminAction } from "./api.js";


export function initAdminMain(){
const btnA = document.getElementById('btn-approvals');
const area = document.getElementById('admin-area');
btnA?.addEventListener('click', async ()=>{
area.innerHTML = `<h3>승인/거부/재오픈</h3><div class="list" id="ap-list"></div>`;
// TODO: 서버에서 목록 불러오기. 데모 행
const demo = [ {id:901, title:'요청 #901'}, {id:902, title:'요청 #902'} ];
const list = document.getElementById('ap-list');
list.innerHTML = demo.map(r=>row(r)).join('');
wire(list);
});
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