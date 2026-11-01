# Web flasher

A page on GitHub Pages that flashes Muse Gadget firmware from Chrome or Edge
over Web Serial, using [ESP Web Tools](https://esphome.github.io/esp-web-tools/).
The ESP32 CI (`.github/workflows/esp32.yml`) packages the boards listed in
`boards.json` from its own builds, assembles the site on every run, and deploys
it on pushes to `main`.

## The SDK token

The site's builds have no SDK token, and a gadget needs one to pair. After
installing, the page asks for the maker's token and sends it to the gadget
over serial as `>sdk_token=mgst_…` (`sdk-token.js`). The gadget stores it in
NVS, answers `@sdk_token ok` and restarts with it; NVS survives updates from
the page, so it's needed once per gadget. The firmware side is
`esp32/main/sdk_token_console.h`: Muse boards take the command on their own
console, other boards on the console UART and the chip's USB Serial/JTAG
port. It's serial-only, so it can't be set over BLE.

## Catching the wrong board

ESP Web Tools refuses a board whose chip doesn't match the build's. On top of
that, `flasher-hooks.js` limits the port picker to the board's `usb` devices
and, before erasing or writing, refuses a board whose flash can't hold the
build's partitions (`min_flash_bytes`, which `make_manifest.py` reads from the
partition table). It doesn't check PSRAM: esptool only sees PSRAM inside the
chip's package, and some boards have it beside the chip.

## Adding a board

Add an entry to `boards.json`. `board` must match a `board` in the build
matrix in `esp32.yml`; the site job fails if it doesn't.

| Field      | Required | Meaning |
|------------|----------|---------|
| `board`    | yes      | Board id, as in the build matrix (or `web-flasher/firmware/<board>/` for pre-signed dual-boot boards). |
| `name`     | yes      | Name shown in the board picker. |
| `usb`      | no       | USB devices the board's console can show up as, as `"vid:pid"` strings (see `esp32/tools/muse/ports.py`). The port picker shows only these; leave it out if you're not sure, so the right port isn't hidden. |
| `pacing`   | no       | Paced serial writes for USB bridges that drop bytes, as `{"chunk": 32, "factor": 2}`: bytes per write, and how many times as long as a chunk takes on the wire to wait after it. Leave it out for boards that flash fine without. |
| `noErase`  | no       | If `true`, `flasher-hooks.js` blocks full-chip erase (`eraseFlash` / `eraseAll`) so dual-boot boards never wipe factory partitions, keys, or NVS. |
| `dualBoot` | no       | If `true`, reveals the **Return to WeatherXM / Web Bluetooth Provisioner** helper card on the flasher page. |
| `note`     | no       | HTML shown under the picker when the board is selected: which port to pick, backups to take first, and so on. |

## WeatherXM `WG1200` Safe Dual-Boot (`wxm-wg1200`)

The `wxm-wg1200` entry flashes the **WeatherXM D1 Wi-Fi Gateway (`WG1200`)** without modifying or erasing its stock WeatherXM firmware (`factory` at `0x20000`, `ota_0` at `0x420000`), signed bootloader (`0x0`), hardware certificates (`0xD000`), NVS (`0xF000`), or SPIFFS (`0xC21000`).

Its pre-signed firmware artifacts live in [`firmware/wxm-wg1200/`](firmware/wxm-wg1200/) and are generated from an RSA-3072 signed build via:

```sh
python3 web-flasher/make_manifest.py \
  esp32/build-muse-wxm-wg1200 \
  web-flasher/firmware/wxm-wg1200 \
  "Muse (WeatherXM WG1200 Dual-Boot)" \
  "$(tr -d '\n' < esp32/version.txt)+$(git rev-parse --short HEAD)"
```

To serve both the **Web Flasher** and the **Full Web Bluetooth Provisioner** locally in Chrome:

```sh
python3 esp32/tools/muse/muse_setup_server.py
# Web Flasher:               http://localhost:8099/web-flasher/
# Web Bluetooth Provisioner: http://localhost:8099/
```

## Testing locally

Download the `github-pages` artifact from an ESP32 CI run, unpack
`artifact.tar` and serve it on localhost; Chrome allows Web Serial there
without https:

```sh
gh run download RUN_ID -n github-pages -D /tmp/flasher
mkdir /tmp/flasher/site && tar -xf /tmp/flasher/artifact.tar -C /tmp/flasher/site
python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/flasher/site
```

To try changes to the page itself, copy `index.html` and the `.js` and
`boards.json` files over the unpacked site and reload.
