---
"@e2e-dev/smol": minor
---

`smol({ target: 'cloud' })` runs the browser machines on smol cloud with the API key in `SMOL_CLOUD_TOKEN` (and an optional `SMOL_CLOUD_URL`) from the run's environment. Each worker slot's browser gets a connect token that opens only that browser and its branches, and every lease's DevTools URL carries that token, never the API key. `app.source` is uploaded as an archive, and `hostPorts` is refused with `target: 'cloud'`. Leases are now DevTools WebSocket URLs built from the machine's own endpoint, and nginx sends Chromium `Host: localhost`, so the endpoint no longer depends on the address Chromium sees.
