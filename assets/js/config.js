(function(){
  const DEFAULT_API_BASE = "https://aams-api.onrender.com";

  const initialConfig = (typeof window.AAMS_CONFIG === "object" && window.AAMS_CONFIG) || {};
  const config = {
    API_BASE: initialConfig.API_BASE || DEFAULT_API_BASE,
    WSS_BASE: initialConfig.WSS_BASE || ""
  };

  let storageWarned = false;
  const warnStorage = (action, err) => {
    if (storageWarned) return;
    storageWarned = true;
    if (err) {
      console.warn(`[AAMS][config] localStorage ${action} 실패`, err);
    } else {
      console.warn(`[AAMS][config] localStorage ${action} 실패`);
    }
  };

  const readStorage = (key) => {
    try {
      const value = localStorage.getItem(key);
      return value == null ? "" : value;
    } catch (err) {
      warnStorage("read", err);
      return "";
    }
  };

  const writeStorage = (key, value) => {
    try {
      if (value == null || value === "") {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch (err) {
      warnStorage("write", err);
    }
  };

  const deriveWsBase = (apiBase) => {
    if (!apiBase) return "";
    try {
      const url = new URL(apiBase);
      const scheme = url.protocol === "https:" ? "wss:" : "ws:";
      return `${scheme}//${url.host}`;
    } catch {
      if (apiBase.startsWith("https://")) return apiBase.replace(/^https:/i, "wss:");
      if (apiBase.startsWith("http://")) return apiBase.replace(/^http:/i, "ws:");
      return "";
    }
  };

  const params = new URLSearchParams(window.location.search || "");
  const overrideApi = (params.get("api_base") || params.get("api") || "").trim();
  const overrideWs = (params.get("ws_base") || params.get("wss_base") || params.get("ws") || "").trim();
  const resetApi = params.get("reset_api") || params.get("clear_api");
  const resetWs = params.get("reset_ws") || params.get("clear_ws");


  const storedApi = readStorage("AAMS_API_BASE").trim();
  const storedWs = readStorage("AAMS_WS_BASE").trim();

  if (resetApi) {
    writeStorage("AAMS_API_BASE", null);
  }
  if (resetWs) {
    writeStorage("AAMS_WS_BASE", null);
  }

  if (overrideApi) {
    config.API_BASE = overrideApi;
    writeStorage("AAMS_API_BASE", overrideApi);
  } else if (storedApi) {
    config.API_BASE = storedApi;
  }

  if (!config.API_BASE) {
    config.API_BASE = DEFAULT_API_BASE;
  }

  const derivedWs = deriveWsBase(config.API_BASE);

  if (overrideWs) {
    config.WSS_BASE = overrideWs;
    writeStorage("AAMS_WS_BASE", overrideWs);
  } else if (storedWs) {
    config.WSS_BASE = storedWs;
  } else if (!config.WSS_BASE) {
    config.WSS_BASE = derivedWs;
  }

  if (!config.WSS_BASE) {
    config.WSS_BASE = derivedWs;
  }

  window.AAMS_CONFIG = config;
  window.FP_SITE = window.FP_SITE || "site-01";
})();