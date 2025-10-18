// assets/js/util.js

// === API BASE (전역 config.js, meta, localStorage 순서) ===
export function getApiBase() {
  if (window.AAMS_CONFIG && typeof window.AAMS_CONFIG.API_BASE === "string") {
    return window.AAMS_CONFIG.API_BASE;
  }
  const meta = document.querySelector('meta[name="aams-api-base"]')?.content;
  if (meta) return meta;

  const saved = localStorage.getItem("AAMS_API_BASE");
  if (saved) return saved;

  return ""; // 같은 출처 프록시 환경
}

// === 상단 모바일 헤더 주입 (서브 페이지용) ===
export async function mountMobileHeader({ title, backTo = "#/", homeTo = "#/" } = {}) {
  const top = document.getElementById("top");
  if (!top) return;

  // 폴더/파일명이 다를 수 있으니 후보 경로 순차 시도
  const candidates = [
    "./components/mobile_header.html",
    "./components/header_mobile.html"
  ];
  let html = "";
  for (const p of candidates) {
    try {
      const r = await fetch(p, { cache: "no-store" });
      if (r.ok) { html = await r.text(); break; }
    } catch {}
  }
  if (!html) {
    // 컴포넌트가 없더라도 기본 버튼만 표시
    top.innerHTML = `
      <header class="m-header">
        <button class="m-btn" id="m-back" aria-label="뒤로">←</button>
        <div class="m-title" id="m-title"></div>
        <button class="m-btn" id="m-home" aria-label="홈">⌂</button>
      </header>`;
  } else {
    top.innerHTML = html;
  }

  const t = document.getElementById("m-title"); if (t) t.textContent = title || "";
  document.getElementById("m-back")?.addEventListener("click", ()=>{ location.hash = backTo; });
  document.getElementById("m-home")?.addEventListener("click", ()=>{ location.hash = homeTo; });
}

// === 내 정보 렌더 ===
export function getMe() {
  try { return JSON.parse(localStorage.getItem("AAMS_ME") || "null") || {}; }
  catch { return {}; }
}
export function renderMeBrief(me) {
  const box = document.getElementById("me-brief"); if (!box) return;
  if (!me?.id) { box.innerHTML = `<div class="muted">로그인되지 않음</div>`; return; }
  box.innerHTML =
    `<div><b>${me.name||"사용자"}</b> ${me.rank?`(${me.rank})`:""}</div>` +
    `<div>군번: ${me.serial||"-"}</div>` +
    `<div>소속: ${me.unit||"-"}</div>`;
}

// === (선택) API BASE 간단 헬스체크 배너 ===
export async function assertApiBaseHealthy() {
  const base = getApiBase();
  if (!base) return; // 프록시 환경일 수 있음
  try {
    const r = await fetch(base + "/health", { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    showTopBanner(
      `⚠️ API_BASE(${base}) 접근 실패: /health 체크 불가 (${e.message||e}). config.js 도메인 확인`
    );
  }
}
function showTopBanner(msg) {
  if (document.getElementById("aams-banner")) return;
  const div = document.createElement("div");
  div.id = "aams-banner";
  div.style.cssText = "position:sticky;top:0;z-index:9999;background:#B91C1C;color:#fff;padding:8px 12px;font-size:14px";
  div.textContent = msg;
  document.body.prepend(div);
}
