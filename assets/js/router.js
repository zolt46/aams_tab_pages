import * as Auth from "./auth.js";
import * as FP from "./fingerprint.js";
import * as UserPage from "./user.js";
import * as AdminPage from "./admin.js";

import { assertApiBaseHealthy } from "./util.js";


// 라우트별: 1) 주입할 파일 후보, 2) 주입 후 실행할 init 함수
const routes = {
  // "#/": { candidates:["./pages/index.html","./index_body.html"], init: Auth.initMain }, // ❌ 수정 전
  "#/":            { candidates:["./index_body.html"],  init: Auth.initMain },
  "#/admin-login": { candidates:["./admin_login.html"], init: Auth.initAdminLogin },
  "#/fp-user":     { candidates:["./fp_user.html"],     init: FP.initFpUser },
  "#/fp-admin":    { candidates:["./fp_admin.html"],    init: FP.initFpAdmin },
  "#/user":        { candidates:["./user_main.html"],   init: UserPage.initUserMain },
  "#/admin":       { candidates:["./admin_main.html"],  init: AdminPage.initAdminMain },
};

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
  const path = location.hash || "#/";
  const route = routes[path] || routes["#/"];
  try{
    const html = await loadFirst(route.candidates);
    app.innerHTML = html;            // 1) 조각 주입
    await route.init?.();            // 2) 조각용 초기화 실행 (여기가 ⬅ 핵심!)
  }catch(e){
    showError(`라우트: ${path}\n시도: ${route.candidates.join(" | ")}\n오류: ${e.message}`);
  }
}

// ...
export function bootstrap(){
  addEventListener("hashchange", mountRoute);
  addEventListener("DOMContentLoaded", async () => {
    await assertApiBaseHealthy(); // ⬅️ 첫 로드에 API_BASE 건강 체크
    mountRoute();
  });
  if (!location.hash) location.hash = "#/";
}