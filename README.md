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

## Overriding for development

Append `?api_base=https://staging-api.example.com` (and/or `fp_base=...`) to the TAB URL to switch endpoints temporarily. Use `?reset_api=1` or `?reset_fp=1` to clear stored overrides.
