(function applyRuntimeEnv() {
  try {
    const metaEnv = (typeof import.meta !== 'undefined' && import.meta.env) || {};
    const runtimeEnv = Object.assign({}, window.__AAMS_ENV__ || {}, metaEnv);
    window.__AAMS_ENV__ = runtimeEnv;
    if (typeof window.__applyAamsEnv === 'function') {
      window.__applyAamsEnv(runtimeEnv);
    }
  } catch (err) {
    console.warn('[AAMS][env] 런타임 환경 변수 주입 실패', err);
  }
})();
