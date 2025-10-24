# TAB Front-end Runtime Configuration

The static bundle reads environment variables from two sources:

1. **`window.__AAMS_ENV__`** – Injected by Render or a custom script.
2. **`import.meta.env`** – Automatically populated when the assets are built with Vite.

At runtime the script `assets/js/env.inject.js` copies these values and calls `window.__applyAamsEnv`, which in turn stores the public API endpoints in `window.AAMS_CONFIG`.

## Required variables

```
VITE_API_URL=https://aams-api.example.com
VITE_FP_BASE=https://fp-bridge.example.com
```

*Only HTTPS URLs are accepted.* The last-used API URL is persisted in `localStorage` so that offline reloads continue to work.

## 로컬 브릿지(지문 서버) 연결 안내 (한국어)

- 보안 정책으로 인해 HTTPS 페이지에서 HTTP 로컬(예: `http://127.0.0.1:8790`)로 직접 요청이 차단될 수 있습니다.
- 이 경우 TAB 화면 상단/지문 화면에 표시되는 "로컬 연결" 버튼을 한 번 클릭해 로컬 브릿지 팝업을 열어 주세요. 팝업을 통해 브라우저 간 메시지 채널이 설정되고 이후 지문 명령이 정상 전달됩니다.
- 팝업이 차단되면 브라우저 주소창 우측의 팝업 차단 알림에서 허용 후 다시 시도하세요.
- 로컬 브릿지 주소 변경은 상태 모니터의 "로컬" 항목을 클릭해 입력할 수 있습니다. 기본값은 `http://127.0.0.1:8790` 입니다.

## Overriding for development

Append `?api_base=https://staging-api.example.com` (and/or `fp_base=...`) to the TAB URL to switch endpoints temporarily. Use `?reset_api=1` or `?reset_fp=1` to clear stored overrides.
