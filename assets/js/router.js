const routes = {
'#/': '/pages/index.html',
'#/login': '/pages/login.html',
'#/user': '/pages/user_main.html',
'#/admin': '/pages/admin_main.html',
};


export async function mountRoute() {
const app = document.getElementById('app');
const path = location.hash || '#/' ;
const file = routes[path] || routes['#/'];
const html = await fetch(file).then(r=>r.text());
app.innerHTML = html;
}


export function bootstrap(){
addEventListener('hashchange', mountRoute);
addEventListener('DOMContentLoaded', mountRoute);
if (!location.hash) location.hash = '#/';
}