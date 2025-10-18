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

// === 상단 모바일 헤더 주입 ===
/**
 * @param {object} options
 * @param {string} options.title - 페이지 제목
 * @param {'login' | 'main' | 'subpage'} [options.pageType='subpage'] - 페이지 종류 (버튼 구성 결정)
 * @param {string} [options.backTo='#/'] - 뒤로가기 시 이동할 해시
 * @param {string} [options.homeTo] - 홈 버튼 클릭 시 이동할 해시 (지정 안하면 역할 기반 자동 설정)
 */

// === 상단 모바일 헤더 주입 (서브 페이지용) ===
import { logout } from "./auth.js";
 export async function mountMobileHeader({
   title="AAMS",
   pageType="main",
   showLogout=true,
   backTo="#/",
   homeTo
 } = {}) {

  const top = document.getElementById("top");
  if (!top) return;

  // 헤더 HTML 로드 (기존과 유사, 실패 시 기본 구조 사용)
  const candidates = [
    "./components/mobile_header.html",
    "./components/header_mobile.html",
    "./mobile_header.html" // 루트 경로도 시도
  ];
  let html = "";
  try {
    for (const p of candidates) {
      const r = await fetch(p, { cache: "no-store" });
      if (r.ok) { html = await r.text(); break; }
    }
  } catch {}

  if (!html) { // 기본 구조 사용
    top.innerHTML = `
      <header class="m-header">
        <button class="m-btn" id="m-back" aria-label="뒤로">←</button>
        <div class="m-title" id="m-title"></div>
        <div class="m-spacer"></div>
        <button class="m-btn" id="m-refresh" aria-label="새로고침">🔄</button>
        <button class="m-btn" id="m-logout" aria-label="로그아웃">🚪</button>
        <button class="m-btn" id="m-home" aria-label="홈" style="display: none;">⌂</button>
      </header>`;
  } else {
    top.innerHTML = html;
  }

  // 요소 가져오기
  // 요소 확보(없으면 생성해서 강제 주입)
  const header = top.querySelector("header") || top;
  const ensureBtn = (id, label) => {
    let el = header.querySelector(`#${id}`);
    if (!el) {
      el = document.createElement("button");
      el.id = id;
      el.className = "m-btn";
      el.textContent = label;
      // 버튼 모음 영역이 있으면 거기에, 없으면 header 끝에
      (header.querySelector(".app-actions") || header).appendChild(el);
    }
    if (id === "m-back" || id === "m-refresh" || id === "m-home") {
      el.classList.add("icon-btn");
    }
    if (id === "m-logout") {
      el.classList.add("solid-btn");
    }
    return el;
  };
  const titleEl   = header.querySelector("#m-title") || header.querySelector(".m-title");
  const backBtn   = header.querySelector("#m-back")    || ensureBtn("m-back", "←");
  const refreshBtn= header.querySelector("#m-refresh") || ensureBtn("m-refresh", "🔄");
  const logoutBtn = header.querySelector("#m-logout")  || (showLogout ? ensureBtn("m-logout","로그아웃") : null);
  const homeBtn   = header.querySelector("#m-home")    || ensureBtn("m-home", "⌂");

  // 제목 설정
  if (titleEl) titleEl.textContent = title || "";

  // 버튼 표시/숨김 및 기능 설정
  const show = (el) => { if (el) el.style.display = 'flex'; } // SVG 때문에 flex
  const hide = (el) => { if (el) el.style.display = 'none'; }

  if (pageType === 'login') {
    // 로그인/지문 페이지: 뒤로가기, 새로고침만 표시
    show(backBtn);
    show(refreshBtn);
    if (logoutBtn) hide(logoutBtn);
    hide(homeBtn);
    if (backBtn) backBtn.addEventListener("click", () => { location.hash = backTo; });
  } else if (pageType === 'main') {
    // 사용자/관리자 메인: 뒤로가기 숨김, 새로고침, 로그아웃 표시 (홈 버튼은 의미 없으므로 숨김)
    hide(backBtn);
    show(refreshBtn);
    if (showLogout && logoutBtn) show(logoutBtn); else if (logoutBtn) hide(logoutBtn);
    hide(homeBtn);
  } else { // 'subpage' (기본값)
    // 하위 페이지: 뒤로가기, 새로고침, 로그아웃, 홈 모두 표시
    show(backBtn);
    show(refreshBtn);
    if (showLogout && logoutBtn) show(logoutBtn); else if (logoutBtn) hide(logoutBtn);
    show(homeBtn);
    if (backBtn) backBtn.addEventListener("click", () => { location.hash = backTo; });
  }

  // 새로고침 버튼 공통 로직
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => { location.reload(); });
  }

  // 로그아웃 버튼 공통 로직 (로그인 페이지 제외)
  if (logoutBtn && pageType !== 'login' && showLogout) {
    logoutBtn.addEventListener("click", () => {
      try { localStorage.removeItem("AAMS_ME"); } catch {}
      try { sessionStorage.removeItem("AAMS_ADMIN_LOGIN_ID"); } catch {}
      location.hash = "#/";
      location.reload();
    });
  }

  // 홈 버튼 공통 로직 (하위 페이지에서만)
  if (homeBtn && pageType === 'subpage') {
    let targetHome = homeTo;
    if (!targetHome) { // homeTo가 지정되지 않았으면 역할 기반 자동 설정
       const me = getMe();
       targetHome = me?.is_admin ? '#/admin' : '#/user';
    }
    homeBtn.addEventListener("click", () => { location.hash = targetHome; });
  }
}


// === 내 정보 렌더 ===
export function getMe() {
  try { return JSON.parse(localStorage.getItem("AAMS_ME") || "null") || {}; }
  catch { return {}; }
}
export function renderMeBrief(me = {}) {
  const box = document.getElementById("me-brief");
  if (!box) return;

  const escape = (value) => String(value ?? "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  if (!me?.id) {
    box.innerHTML = `<div class="muted">로그인되지 않음</div>`;
    return;
  }

  const displayName = `${me.rank ? `${escape(me.rank)} ` : ""}${escape(me.name || "사용자")}`.trim();
  const unit = escape(me.unit || "-");
  const serial = escape(me.serial || me.military_id || "-");
  const weapon = escape(me.weapon_name || me.weapon_code || me.weapon || "-");
  const duty = escape(me.duty || me.role_label || me.role || "-");
  const contact = escape(me.phone || me.contact || "-");

  box.innerHTML = `
    <div class="overview">
      <div class="overview-icon" aria-hidden="true">🛡️</div>
      <div class="overview-text">
        <h3>${displayName}</h3>
        <p>${unit}</p>
      </div>
    </div>
    <div class="overview-meta" role="list">
      <div role="listitem">
        <span class="lbl">군번</span>
        <span class="val">${serial}</span>
      </div>
      <div role="listitem">
        <span class="lbl">주요 장비</span>
        <span class="val">${weapon}</span>
      </div>
      <div role="listitem">
        <span class="lbl">담당 임무</span>
        <span class="val">${duty}</span>
      </div>
      <div role="listitem">
        <span class="lbl">연락처</span>
        <span class="val">${contact}</span>
      </div>
    </div>
    <div class="overview-stats">
      <div class="stat-card">
        <span class="label">집행 대기</span>
        <span class="value" id="pending-count">-</span>
      </div>
      <div class="stat-card">
        <span class="label">최근 요청</span>
        <span class="value" id="latest-request">-</span>
      </div>
    </div>
  `;
}

// === (선택) API BASE 간단 헬스체크 배너 ===
export async function assertApiBaseHealthy() {
  const base = getApiBase();
  if (!base) return; // 프록시 환경일 수 있음
  try {
    const r = await fetch(base + "/health");
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
