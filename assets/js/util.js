export async function mountMobileHeader({ title, backTo="#/", homeTo="#/" } = {}){
  const top = document.getElementById("top"); if (!top) return;
  const candidates = ["./components/mobile_header.html","./components/header_mobile.html"];
  let html = "";
  for (const p of candidates){
    try { const r = await fetch(p); if (r.ok){ html = await r.text(); break; } } catch {}
  }
  if (!html){ top.innerHTML = ""; return; }
  top.innerHTML = html;
  const t = document.getElementById("m-title"); if (t) t.textContent = title || "";
  document.getElementById("m-back") ?.addEventListener("click", ()=>{ location.hash = backTo;  });
  document.getElementById("m-home") ?.addEventListener("click", ()=>{ location.hash = homeTo; });
}

export function getApiBase(){ return localStorage.getItem("AAMS_API_BASE") || ""; }
export function getMe(){ try { return JSON.parse(localStorage.getItem("AAMS_ME")||"null") || {}; } catch { return {}; } }
export function renderMeBrief(me){
  const box = document.getElementById("me-brief"); if (!box) return;
  if (!me?.id){ box.innerHTML = `<div class="muted">로그인되지 않음</div>`; return; }
  box.innerHTML = `<div><b>${me.name||"사용자"}</b> ${me.rank?`(${me.rank})`:""}</div>
                   <div>군번: ${me.serial||"-"}</div><div>소속: ${me.unit||"-"}</div>`;
}
