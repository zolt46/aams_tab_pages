import * as Auth from "./auth.js";
import * as FP from "./fingerprint.js";
import * as UserPage from "./user.js";
import * as AdminPage from "./admin.js";
import * as ExecutePage from "./execute.js";
import * as AdminFpPage from "./admin_fp.js";

import { assertApiBaseHealthy } from "./util.js";
import { mountStatusMonitor, unmountStatusMonitor, refreshStatusMonitor } from "./health_monitor.js";


// 라우트별: 1) 주입할 파일 후보, 2) 주입 후 실행할 init 함수
const routes = {
  // "#/": { candidates:["./pages/index.html","./index_body.html"], init: Auth.initMain }, // ❌ 수정 전
  "#/":            { candidates:["./index_body.html", "./pages/index.html"], init: Auth.initMain },
  "#/admin-login": { candidates:["./pages/admin_login.html", "./admin_login.html"], init: Auth.initAdminLogin },
  "#/fp-user":     { candidates:["./pages/fp_user.html", "./fp_user.html"],     init: FP.initFpUser },
  "#/fp-admin":    { candidates:["./pages/fp_admin.html", "./fp_admin.html"],    init: FP.initFpAdmin },
  "#/user":        { candidates:["./pages/user_main.html", "./user_main.html"],   init: UserPage.initUserMain },
  "#/execute":     { candidates:["./pages/user_execute.html", "./user_execute.html"], init: ExecutePage.initExecutionPage },
  "#/admin":       { candidates:["./pages/admin_main.html", "./admin_main.html"],  init: AdminPage.initAdminMain },
  "#/admin-summary": {
    candidates:["./pages/admin_summary.html", "./admin_summary.html"],
    init: AdminPage.initAdminSummary
  },
  "#/admin-requests": {
    candidates:["./pages/admin_requests.html", "./admin_requests.html"],
    init: AdminPage.initAdminRequests
  },
  "#/admin-fp": {
    candidates:["./pages/admin_fp_manage.html"],
    init: AdminFpPage.initAdminFingerprintManage
  },
};

const DEFAULT_ROUTE = "#/";

function normalizeHash(rawHash){
  if (!rawHash) return DEFAULT_ROUTE;
  const trimmed = rawHash.trim();
  if (!trimmed || trimmed === "#" || trimmed === DEFAULT_ROUTE) {
    return DEFAULT_ROUTE;
  }

  if (trimmed.startsWith("#/")) {
    return trimmed;
  }

  const withoutPrefix = trimmed.replace(/^#?\/?/, "");
  return withoutPrefix ? `#/${withoutPrefix}` : DEFAULT_ROUTE;
}

function safeReplaceHash(nextHash, { addHistory = false } = {}){
  if (location.hash === nextHash) return;
  try {
    if (!addHistory && typeof history?.replaceState === "function") {
      history.replaceState(null, "", nextHash);
    } else {
      location.hash = nextHash;
    }
  } catch {
    try { location.hash = nextHash; } catch {}
  }
}

function resolveRoute(rawHash){
  const requested = normalizeHash(rawHash);
  if (requested !== rawHash) {
    safeReplaceHash(requested);
  }

  const matched = routes[requested];
  if (matched) {
    return { key: requested, config: matched };
  }

  const fallback = routes[DEFAULT_ROUTE];
  if (!fallback){
    return { key: requested, config: null };
  }

  if (requested !== DEFAULT_ROUTE){
    console.warn(`[AAMS] 알 수 없는 라우트(${rawHash || "(빈 값)"}) -> ${DEFAULT_ROUTE}로 대체합니다.`);
    safeReplaceHash(DEFAULT_ROUTE);
  }

  return { key: DEFAULT_ROUTE, config: fallback };
}



async function loadFirst(paths){
  let lastErr;
  for (const p of paths){
    try{
      const r = await fetch(p, { cache: "no-store" });
      if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
      return await r.text();
    }catch(e){ lastErr = e; }
  }
  console.error("[AAMS] loadFirst 실패. 시도 경로:", paths);
  throw new Error("모든 후보 경로에서 로딩 실패");
}

function showError(msg){
  const app = document.getElementById("app");
  app.innerHTML = `
    <div style="color:#fff;background:#111;padding:16px;border:1px solid #333;border-radius:12px;max-width:880px;margin:24px auto;white-space:pre-wrap">
      페이지 로딩 실패\n${msg}\n(힌트) 경로는 상대경로(./)인지, 파일명이 정확한지 확인하세요.
    </div>`;
}

export async function mountRoute(){
  const app = document.getElementById("app");
  if (window.AAMS_LOCKDOWN_GUARD?.shouldBlock?.(location.hash)) {
    window.AAMS_LOCKDOWN_GUARD.enforce?.(location.hash);
    return;
  }
  const { key, config } = resolveRoute(location.hash);

  if (!config){
    const known = Object.keys(routes).join(", ");
    showError(`라우트: ${key}\n오류: 지원되지 않는 라우트입니다.\n정의된 라우트: ${known || "(없음)"}`);
    return;
  }

  try{
    const html = await loadFirst(config.candidates ?? []);
    app.innerHTML = html;            // 1) 조각 주입
    if (key === "#/execute") {
      unmountStatusMonitor();
    } else {
      mountStatusMonitor({ immediate: false });
    }
    await config.init?.();           // 2) 조각용 초기화 실행 (여기가 ⬅ 핵심!)
    if (key !== "#/execute") {
      refreshStatusMonitor();
    }
  }catch(e){
    const tried = config.candidates?.join(" | ") ?? "(없음)";
    showError(`라우트: ${key}\n시도: ${tried}\n오류: ${e.message}`);
  }
}

// ★ 모든 화면에서 로고 5번 탭 시 관리자 로그인으로
function setupHiddenAdminShortcut() {
  let taps = 0;
  let timer = null;

  const reset = () => { taps = 0; clearTimeout(timer); timer = null; };

  // 캡처링 단계로 걸어서 겹겹이 감싼 요소/버블링 이슈 회피
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('#logo, .entry-logo');
    if (!el) return;

    taps += 1;
    if (!timer) timer = setTimeout(reset, 2000); // 2초 이내 5번
    if (taps >= 5) {
      reset();
      location.hash = '#/admin-login';
    }
  }, true);
}

// ...
export function bootstrap(){
  setupHiddenAdminShortcut();
  const normalized = normalizeHash(location.hash);
  if (normalized !== location.hash){
    safeReplaceHash(normalized, { addHistory: !location.hash });
  }

  addEventListener("hashchange", mountRoute);
  addEventListener("DOMContentLoaded", async () => {
    await assertApiBaseHealthy(); // ⬅️ 첫 로드에 API_BASE 건강 체크
    await mountRoute();
  });

}