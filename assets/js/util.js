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

export function getApiBase() {
  // 1) 전역 설정 파일 (권장)
  if (window.AAMS_CONFIG?.API_BASE) return window.AAMS_CONFIG.API_BASE;

  // 2) <meta name="aams-api-base" content="..."> 로도 주입 가능 (선택)
  const meta = document.querySelector('meta[name="aams-api-base"]')?.content;
  if (meta) return meta;

  // 3) (옵션) 이전에 쓰던 localStorage 값 지원
  const saved = localStorage.getItem("AAMS_API_BASE");
  if (saved) return saved;

  // 4) 기본값: 같은 출처 (리버스 프록시로 /api 붙여놓은 경우)
  return "";
}
export function getMe(){ try { return JSON.parse(localStorage.getItem("AAMS_ME")||"null") || {}; } catch { return {}; } }
export function renderMeBrief(me){
  const box = document.getElementById("me-brief"); if (!box) return;
  if (!me?.id){ box.innerHTML = `<div class="muted">로그인되지 않음</div>`; return; }
  box.innerHTML = `<div><b>${me.name||"사용자"}</b> ${me.rank?`(${me.rank})`:""}</div>
                   <div>군번: ${me.serial||"-"}</div><div>소속: ${me.unit||"-"}</div>`;
}
