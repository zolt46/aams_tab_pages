import { verifyFingerprint } from './fingerprint.js';


const ADMIN_TAP_COUNT = 5;
let logoTap = 0;
let logoTimer;


export async function wireIndexInteractions(){
// inject modal
const slot = document.getElementById('modal-slot');
if (slot) {
try {
const html = await fetch('/components/admin_login_modal.html').then(r=>r.text());
slot.innerHTML = html;
wireAdminModal();
} catch {}
}


const logo = document.getElementById('logo');
logo?.addEventListener('click', ()=>{
clearTimeout(logoTimer);
logoTap++;
logoTimer = setTimeout(()=> (logoTap = 0), 1200);
if (logoTap >= ADMIN_TAP_COUNT) {
document.getElementById('admin-login-modal')?.classList.remove('hidden');
logoTap = 0;
}
});


document.getElementById('btn-login')?.addEventListener('click', async ()=>{
const ok = await verifyFingerprint();
if (ok) location.hash = '#/user';
else alert('지문 인증 실패');
});
}


function wireAdminModal(){
document.getElementById('btn-admin-cancel')?.addEventListener('click', ()=>{
document.getElementById('admin-login-modal')?.classList.add('hidden');
});
document.getElementById('btn-admin-login')?.addEventListener('click', ()=>{
const id = document.getElementById('admin-id')?.value?.trim();
const pw = document.getElementById('admin-pw')?.value?.trim();
if (!id || !pw) return alert('계정/비밀번호 입력');
// TODO: backend admin auth
document.getElementById('admin-login-modal')?.classList.add('hidden');
location.hash = '#/admin';
});
}