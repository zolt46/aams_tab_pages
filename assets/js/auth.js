// assets/js/auth.js
// 메인 화면 초기화 (상단바 없음)
export async function initMain() {
  const logo = document.getElementById("logo");
  const btn  = document.getElementById("btn-login");
  let tap = 0, timer;
  logo?.addEventListener("click", ()=>{
    clearTimeout(timer); tap++; timer = setTimeout(()=> tap=0, 1200);
    if (tap >= 5) { location.hash = "#/admin-login"; tap = 0; }
  });
  btn?.addEventListener("click", ()=>{ location.hash = "#/fp-user"; });
}

// 관리자 로그인 페이지 초기화
import { mountMobileHeader } from "./util.js";
import { verifyAdminCredential } from "./api.js";

export async function initAdminLogin() {
  await mountMobileHeader({ title: "관리자 로그인", backTo: "#/" });
  document.getElementById("btn-admin-next")?.addEventListener("click", async ()=>{
    const id = document.getElementById("admin-id")?.value?.trim();
    const pw = document.getElementById("admin-pw")?.value?.trim();
    if (!id || !pw) return alert("ID/비밀번호를 입력하세요.");
    try {
      const ok = await verifyAdminCredential(id, pw);
      if (!ok) return alert("관리자 인증 실패");
      // 직전 로그인한 관리자 user_id 저장 → fp_admin에서 동일 아이디만 노출
      sessionStorage.setItem("AAMS_ADMIN_LOGIN_ID", id);
      location.hash = "#/fp-admin";
    } catch (e) { alert("로그인 오류: " + e.message); }
  });
}
