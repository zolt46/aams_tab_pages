// assets/js/auth.js
// 메인 화면 초기화 (상단바 없음)
export async function initMain() {
  const logo = document.getElementById("logo");
  const btn  = document.getElementById("btn-login");
  if (logo) {
    const REQUIRED_TAPS = 5;
    const TAP_WINDOW_MS = 3500;
    let tapCount = 0;
    let timeoutId = 0;
    let suppressNextClick = false;

    const resetCounter = () => {
      tapCount = 0;
      lastPointerStamp = 0;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = 0;
      }
    };
    const registerTap = () => {
      tapCount += 1;
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = window.setTimeout(resetCounter, TAP_WINDOW_MS);

      if (tapCount >= REQUIRED_TAPS) {
        resetCounter();
        location.hash = "#/admin-login";
      }
    };

    const onClick = () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      registerTap();
    };

    const onPointerUp = (evt) => {
      if (evt.pointerType === "mouse" && evt.button !== 0) return;
      suppressNextClick = true; // 같은 입력에서 이어질 click은 무시
      registerTap();
    };

    const onKeyDown = (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        registerTap();
      }
    };

    logo.addEventListener("pointerup", onPointerUp, { passive: true });
    logo.addEventListener("click", onClick);
    logo.addEventListener("keydown", onKeyDown);

    if (!logo.hasAttribute("tabindex")) {
      logo.setAttribute("tabindex", "0");
    }
  }
  btn?.addEventListener("click", ()=>{ location.hash = "#/fp-user"; });
}

// 관리자 로그인 페이지 초기화
import { mountMobileHeader } from "./util.js";
import { verifyAdminCredential } from "./api.js";

export async function initAdminLogin() {
  await mountMobileHeader({ title: "관리자 로그인", pageType: 'login', backTo: "#/" });
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

export function logout() {
  try {
    localStorage.removeItem("token");
    localStorage.removeItem("me"); // 로그인 사용자 캐시 사용 중이면 같이 지움
  } catch (e) {}
  location.hash = "#/login";
  location.reload();
 }