// ./assets/js/router.js
import { mountHeader } from "./util.js";
import * as UserPage from "./user.js";
import * as AdminPage from "./admin.js";
import { wireIndexInteractions } from "./auth.js";

const routes = {
  "#/":        { file: "./pages/index.html",  init: async () => { await mountHeader(); await wireIndexInteractions(); } },
  "#/login":   { file: "./pages/login.html",  init: async () => { await mountHeader(); /* login page no-op */ } },
  "#/user":    { file: "./pages/user_main.html",  init: async () => { await mountHeader(); await UserPage.initUserMain(); } },
  "#/admin":   { file: "./pages/admin_main.html", init: async () => { await mountHeader(); await AdminPage.initAdminMain(); } },
};

export async function mountRoute() {
  const app = document.getElementById("app");
  const path = location.hash || "#/";
  const route = routes[path] || routes["#/"];
  const html = await fetch(route.file).then(r=>r.text());
  app.innerHTML = html;
  await route.init?.(); // 페이지별 초기화 실행 (여기서 스크립트 동작)
}

export function bootstrap() {
  addEventListener("hashchange", mountRoute);
  addEventListener("DOMContentLoaded", mountRoute);
  if (!location.hash) location.hash = "#/";
}
