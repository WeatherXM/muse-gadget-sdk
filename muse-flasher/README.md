# Muse × WeatherXM WG1200 Dual-Boot Flasher & Provisioner (`muse-flasher`)

Web-based dual-boot USB flasher, boot slot switcher, SDK token injector and Web Bluetooth provisioner for the **WeatherXM WG1200** gateway (`ESP32-S3`).

Built with **Astro 5**, **Tailwind CSS**, **TypeScript** and a **Cloudflare Worker** with Static Assets. It brings together, in one page:
1. The **WG1200 dual-boot flasher**: `esptool-js` over Web Serial, Secure Boot V2 signature checks, a write guard around identity partitions, and instant `otadata` slot switching.
2. The **Muse Full Setup flow** from [`esp32/tools/muse/muse_full_setup.html`](../esp32/tools/muse/muse_full_setup.html) and [`muse_setup_server.py`](../esp32/tools/muse/muse_setup_server.py), ported to TypeScript: the same Web Bluetooth protocol, form fields and `/api/*` proxy contract.

---

## Features

### Step 1 — USB Firmware Studio (`esptool-js` over Web Serial)
- **Dual-boot layout**:
  - `ota_0` (`0x00420000`, 4 MB): **WeatherXM Official** (`v0.8.39`, `v0.8.34`, `v0.6.2`, RSA-3072 signed)
  - `ota_1` (`0x00820000`, 4 MB): **Muse Gadget OS** (`muse-gadget.bin`, RSA-3072 signed)
  - `muse_nvs` (`0x00F21000`, 64 KB): Muse's own NVS for its credentials
- **Signature check before writing**: each image's Secure Boot V2 block is parsed, its image digest checked, its RSA-PSS signature verified with WebCrypto, and its signing key compared with the manifest's key digest.
- **Whole-slot verification**: after a write, the stub's on-chip MD5 of the slot must match the manifest before `otadata` is switched.
- **Instant slot switching**: when the target slot already holds the same build (matched by the app's ELF SHA-256, since Muse's version is always `999.0.0`) and its on-chip MD5 matches, only the 8 KB `otadata` (`0x00013000`) is rewritten. Otherwise the slot is re-flashed.
- **Write guard**: blocks any write overlapping `bootloader` (`0x0`), `esp_secure_cert` (`0xD000`), `nvs` (`0xF000`), `phy_init` (`0x15000`), `factory` (`0x20000`) or `nvs_key` / SPIFFS (`0xC20000`).
- **Both USB ports**: the port picker shows the WG1200's `USB JTAG/serial debug unit` (`303a:1001`, fast) and CH340 `USB Serial` (`1a86:7523`, paced writes like the static web flasher); tick **Show all serial ports** to list everything.
- **After boot**: the console port is reopened (or found again after the USB-JTAG port re-enumerates), `>sdk_token=…` is resent until the gadget answers `@sdk_token ok`, and the page says plainly when it couldn't confirm the boot or store the token.

### Step 2 — SDK token & 365-day device tokens
- **SDK token over USB serial**: **Write via USB Serial** sends `>sdk_token=mgst_…` to the Muse console at 115200 baud until `@sdk_token ok`. The token is remembered in this browser under the same key as the static web flasher (`muse-sdk-token`).
- **Return to WeatherXM over USB**: sends `>boot.weatherxm` and reports which WeatherXM slot the WG1200 picked.
- **Minting**: paste your **web access token** from a logged-in `muse.ai` tab — the page shows a DevTools snippet with a **Copy** button that fetches it — then **Mint 365-Day Device Tokens** for your `homelink-xxxxxx` node, and **Verify Token** to list your VMs and fill the VM ID.
- **Remembered form**: Wi-Fi SSID, node ID, VM, VM server and tokens are kept in this browser; the Wi-Fi password only when **Remember Wi-Fi password** is ticked (with **Show/Hide**). **Forget saved setup** clears them.

### Step 3 — Web Bluetooth provisioning (same protocol as the firmware)
- **Home Link** (`7fdd3d1c-…`, RX `4d593029-…`, TX `d75dc4ca-…`, [`esp32/main/ble_server.c`](../esp32/main/ble_server.c)): `0xFE`-framed JSON, v5 pairing (`pairing_client_hello` → transcript hash and session id checks → P-256 ECDH + HKDF-SHA256 → AES-256-GCM `pairing_client_finished`), on-device confirmation, then encrypted `provision_v2` with Wi-Fi and the device token pair.
- **Muse Companion** (`4d757365-0001-…`, [`esp32/components/muse/muse_ble.c`](../esp32/components/muse/muse_ble.c)): `key=value` commands (`wifi.ssid`, `wifi.pass`, `wifi.connect`, `hatch.host`, `hatch.vm`, `hatch.token` / `hatch.token+`, `hatch.test`) and a JSON status snapshot.
- **Actions**: 1-Click Full Provision (7 steps: ECDH Hello → Key Derive → Device Confirm → Mint Token → Companion Setup → `provision_v2` → Wi-Fi & Auth OK), Home Link only, Companion only, Test VM Connection and Unpair.
- **Live status**: Home Link and Companion status tables, a pulsing confirmation banner while the WG1200 waits for a tap, a crypto self-test badge, the proxy badge, and colour-coded log lines.

---

## `/api/*` (Cloudflare Worker)

Same contract as [`muse_setup_server.py`](../esp32/tools/muse/muse_setup_server.py). The page calls these same-origin, so the Worker sends no CORS headers.

| Endpoint | Upstream (`https://api.muse.ai`, `X-API-Version: 1.0.0`) |
|---|---|
| `GET /api/health` | — |
| `GET /api/secrets` | — returns `{ sdk_token }` only to `localhost` (or with `MUSE_EXPOSE_SDK_TOKEN=1`) |
| `POST /api/mint` `{ web_token, device_id, sdk_token }` | `POST /device_token/mint`, bearer `web_token` → `{ access_token, refresh_token }` |
| `POST /api/refresh` `{ refresh_token, device_id, sdk_token }` | `POST /device_token/refresh`, bearer `refresh_token` |
| `POST /api/fetch_vms` `{ access_token }` | `GET /fetch_vms` → `{ vm_list }` |
| `POST /api/telemetry` | Optional D1 `flash_events` insert (no-op without a `DB` binding) |

---

## Local development

```bash
cd muse-flasher
npm install
npm run build
npm run preview          # wrangler dev: static site + /api on http://localhost:8787
```

For live-reloading UI work, run `npx wrangler dev` in one terminal and `npm run dev` in another: Astro serves `http://localhost:4321` and proxies `/api` to the Worker on `127.0.0.1:8787`.

Use Chrome or Edge on desktop: Web Serial and Web Bluetooth need Chromium on HTTPS or `localhost`.

To pre-fill your SDK token locally, put it in the git-ignored `.dev.vars`:

```bash
echo 'MUSE_SDK_TOKEN="mgst_..."' > .dev.vars
```

### Syncing firmware after building `esp32/`

`./esp32/tools/wg1200_dualboot.sh build` copies `muse-gadget.bin`, `partition-table.bin` and `otadata_ota1.bin` into `public/firmware/muse/` and regenerates `public/firmware/manifest.json` (size, SHA-256, MD5, app ELF SHA-256 and signing key digest per image). To regenerate it by hand:

```bash
npm run manifest:update
```

### Tests and type checks

```bash
npm test
npm run typecheck
npm run build
```

---

## Deploying to Cloudflare

`wrangler.json` serves `dist/` as Static Assets and runs the Worker first for `/api/*`. Pushes to `main` that touch `muse-flasher/` deploy through [`.github/workflows/muse-flasher-cloudflare.yml`](../.github/workflows/muse-flasher-cloudflare.yml).

### Custom domain
Bind a domain in the dashboard (**Workers & Pages → muse-flasher → Settings → Domains & Routes**) or add `routes` to `wrangler.json`:

```json
"routes": [
  { "pattern": "flash.yourdomain.com", "custom_domain": true }
]
```

### Secrets
A public deployment needs none: every visitor brings their own SDK token and web token. Don't store personal credentials in the Worker. `MUSE_SDK_TOKEN` is only served to `localhost`; to serve it from a private deployment, put the Worker behind Cloudflare Access first, then:

```bash
npx wrangler secret put MUSE_SDK_TOKEN
npx wrangler secret put MUSE_EXPOSE_SDK_TOKEN   # value: 1
```

### Deploy

```bash
npm run deploy
```
