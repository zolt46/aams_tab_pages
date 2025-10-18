export function getApiBase() {
return localStorage.getItem("AAMS_API_BASE") || ""; // same origin fallback
}
export function getMe() {
try { return JSON.parse(localStorage.getItem("AAMS_ME")||"null") || {}; } catch { return {}; }
}
export async function mountHeader() {
const top = document.getElementById("top");
if (!top) return;
const html = await fetch("/components/header.html").then(r=>r.text());
top.innerHTML = html;
}
export function renderMeBrief(me) {
const box = document.getElementById("me-brief");
if (!box) return;
if (!me?.id) {
box.innerHTML = `<div class="muted">로그인되지 않음</div>`;
return;
}
box.innerHTML = `
<div><b>${me.name || "사용자"}</b> (${me.rank || "-"})</div>
<div>군번: ${me.serial || "-"}</div>
<div>소속: ${me.unit || "-"}</div>
`;
}