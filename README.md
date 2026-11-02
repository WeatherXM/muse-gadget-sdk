<!--
Copyright (c) Meta Platforms, Inc. and affiliates.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Give Your AI Agent Eyes on the Sky & a Rooftop Weather Station — Muse Gadget SDK for WeatherXM D1 (`WG1200`)

> WeatherXM's fork of [Meta's Muse Gadgets SDK](https://github.com/facebookincubator/muse-gadget-sdk), ported to the WeatherXM D1 gateway. The upstream README follows [below](#about-the-muse-gadgets-sdk-upstream).

<p align="center">
  <b>Most AI agents can tell you the forecast. This one looks at the sky outside your window—and measures the actual weather on your roof.</b><br>
  Muse gets live rooftop sensors (<code>sensors.read</code>), sky-camera snapshots from your LAN without port forwarding (<code>lan.fetch</code>) and a <code>480×480</code> canvas (<code>display.draw_file</code>), in a reversible dual-boot (<code>ota_1</code>) that leaves stock WeatherXM untouched.<br>
  <a href="https://weatherxm.com/product/wb1200-wifi-d1/"><b>WeatherXM D1 Wi-Fi Station (<code>WS1001</code> + <code>WG1200</code>): $50 off with <code>MUSE50</code> → $149</b></a> · <a href="esp32/devices/wxm-wg1200.md"><b>Hardware & Dual-Boot Guide →</b></a> · <a href="https://weatherxm.github.io/muse-gadget-sdk/"><b>⚡ 1-Click Web Flasher</b></a>
</p>

| [WeatherXM D1 (`WS1001` + `WG1200`)](https://weatherxm.com/stations/d1-wifi/) + a LAN camera | `WG1200` running Muse (`ota_1` dual-boot) |
|:---:|:---:|
| <a href="https://weatherxm.com/stations/d1-wifi/"><img src=".github/images/weatherxm-d1-station-camera.jpg" width="410" alt="WeatherXM D1 outdoor solar station and WG1200 4-inch touchscreen gateway, with a Sonoff IP camera running Thingino"></a> | <img src=".github/images/wg1200-muse-desk.jpg" width="410" alt="WeatherXM WG1200 on desk running Muse Gadget firmware connected to Muse VM"> |
| A solar 8-sensor array (`WS1001` / `WS1300`) reports every ~20 s over Sub-GHz LoRa (up to 1 km) to the 4" `WG1200` console. Any camera with an HTTP snapshot URL works, here a Sonoff on [Thingino](https://github.com/themactep/thingino-firmware). | Paired to the Muse VM over an encrypted Noise session: it answers weather questions (`sensors.read`), fetches camera frames (`lan.fetch`) and draws `480×480` cards. |
| <img src=".github/images/sky-camera-frame-480.jpg" width="480" alt="Rooftop sky camera frame over Athens, 1 November 2026 16:56: broken cumulus with blue gaps and low sun, weather station masts in the foreground"> | <img src=".github/images/wg1200-sky-frame.jpg" width="410" alt="The same sky camera frame drawn on the WG1200 screen by Muse with display.draw_file"> |
| **What Muse sees:** the rooftop camera's 1920×1080 frame, fetched through the `WG1200` (~150 KB in ~200 ms) and analysed next to wind, rain and irradiance. | **What it sends back:** the same frame, drawn with `display.draw_file`. The camera never leaves the home network and no ports are opened. |
| <img src=".github/images/wg1200-card-cyberpunk.jpg" width="410" alt="The WG1200 on a desk showing a cyberpunk-neon Athens weather card Muse generated: 21.6 °C, humidity 64%, pressure 1009 hPa, wind, rain and UV"> | <img src=".github/images/wg1200-card-diorama-480.jpg" width="410" alt="A 480x480 isometric-diorama Athens weather card Muse generated: a rooftop weather station beside the Acropolis, 18.4 °C, humidity 83%, pressure 1009 hPa"> |
| **The screen is Muse's canvas:** cards, frames, charts or alerts it composes in its VM and draws with `display.draw_file` / `display.draw_url`. | **Any style:** each card is generated from the latest `sensors.read` values. Swipe down for a new one, or ask Muse for a style. |

<p align="center">
  <img src=".github/images/wg1200-weather-cards-collage.jpeg" width="900" alt="Unique AI-generated 480x480 weather cards rendered on the WeatherXM WG1200 from live WS1001/WS1300 LoRa weather station telemetry"><br>
  <sub>More cards Muse has drawn on the <code>WG1200</code> from live station readings.</sub>
</p>

---

## Why a weather station?

Most AI hardware is a bare board on a USB cable, and most desk displays show static widgets. The `WG1200` gives Muse four things in one console:

- **Ground truth and eyes on your LAN.** Live rooftop telemetry (`sensors.read`), the devices on your Wi-Fi (`device.discover`), and fetches from them (`lan.fetch`): a camera's view of the sky, an inverter's output, a hub's state. See [Eyes on the sky](#eyes-on-the-sky-cameras--rooftop-sensors).
- **A `480×480` canvas, not a dashboard.** Muse draws whatever it composes (`display.draw_file`, `display.draw_url`) and pushes alert cards with a chime (`wg1200.notify`).
- **A reversible dual-boot.** Muse installs into `ota_1` (`0x820000`) with its own `muse_nvs`; WeatherXM firmware, station identity, certificates and NVS are never touched. Hold the top button 10 s to go back. Fits the **$199 Network Edition** ($149 with `MUSE50`) and the **$299 Open Edition** ($249).
- **Sub-GHz LoRa.** The built-in `SX1262` receives `WS1001` / `WS1300` stations up to ~1 km away; with Meshtastic / MeshCore multi-hop mesh ([WeatherXM D2 Mesh](https://www.crowdsupply.com/weatherxm/weatherxm-d2-mesh)), telemetry and agent messages can travel hundreds of km off-grid.

### What Muse can do on the `WG1200` (`wxm-wg1200`)

| Command | What it does |
|---|---|
| `sensors.read` | Outdoor temperature, humidity, wind speed, gust and direction, UV, irradiance (`W/m²`), light, rain rate (`mm/h`) and daily rain (`mm`, kept across reboots), plus indoor pressure (`hPa`). Locks onto your own station so neighbours' never mix in. |
| `display.draw_file` · `display.draw_url` · `display.show_animation` | Draws `480×480` cards, charts or images on demand. |
| `wg1200.notify` | Pushes a dismissible alert card, optionally with a buzzer chime. |
| `device.discover` | Finds devices on your Wi-Fi (ARP, mDNS, SSDP, WS-Discovery and more). |
| `lan.fetch` | Fetches a URL on your home network that the cloud VM can't reach, such as a camera snapshot or a local JSON API ([details](#cameras--home-network-devices-lanfetch)). |
| `device.boot_weatherxm` | Reboots into stock WeatherXM. |

On the screen, **swipe down** (or tap **Draw Weather Card**) for a one-off `480×480` card from your live weather in a random style: Ukiyo-e, Studio Ghibli, Art Deco, Synthwave, 16-bit RPG, Bauhaus and more. It's also a quick check that Muse is connected. The console has no mic, so one-tap actions (**Hyperlocal Brief**, **Draw Weather Card**, **LAN Smart Home Check**) send your live weather with the request and stream Muse's answer on screen.

---

## Eyes on the sky: cameras + rooftop sensors

A cloud agent can't see your home network: its VM has no route to your LAN, and the usual workarounds are port forwarding, a vendor cloud or a Raspberry Pi. With `lan.fetch` the `WG1200` fetches for it. Muse asks for `http://<camera>/snapshot.jpg`; the ESP32-S3 GETs it on the LAN (~200 ms), checks its SHA-256 in PSRAM and returns it over the encrypted session it already holds.

The same device holds time-aligned ground truth from the roof, so one turn can pair a sky frame with the latest LoRa readings to:

- **cross-check conditions:** "overcast" against an irradiance drop, "raining" against rain rate, fog against humidity and dewpoint spread;
- **catch what sensors miss:** a storm cell on the horizon, virga, snow, hail, smoke, a shaded sensor;
- **build a self-labelled dataset:** every frame paired with co-located `W/m²`, pressure, wind and rain;
- **answer on the desk:** a card (`display.draw_file`), an overlay, a chime alert (`wg1200.notify`) or a reply on your phone.

**Next: an agentic `SETI@home` for nowcasting.** Stations on neighbouring rooftops (~1 km apart), and regional nodes linked over multi-hop LoRa mesh, each run their own Muse agent. They find each other through signed rendezvous and task each other (*"capture the sky at T+90 s, signed"*) for stereo cloud-base height, optical flow and a shadow-arrival countdown on the neighbour's screen. Every short-term prediction is graded by the physical sensors (did irradiance drop at the predicted minute? did rain start on time?), and the scored nowcasts become a service other agents and solar PV systems can subscribe to.

| Works today | Next |
|---|---|
| Camera frames through the gateway (`lan.fetch`), tested with Thingino | Agents discovering and talking to each other (rendezvous) |
| Live station telemetry from the same device (`sensors.read`) | Signed frames and readings, so other agents can trust their source |
| Analysis in Muse's VM, results drawn on the gateway's screen | Multi-camera cloud tracking, stereo cloud height, the nowcast service |

### Cameras & home-network devices (`lan.fetch`)

Ask Muse something like *"fetch my camera's snapshot with lan.fetch and show it with display.draw_file"*. The call is `{"url": "http://192.168.1.20/x/ch1.jpg?token=…"}`.

- **Cameras:** any HTTP snapshot URL: Thingino (`/x/ch1.jpg?token=…`), Hikvision (`/ISAPI/Streaming/channels/101/picture`), Dahua and Amcrest (`/cgi-bin/snapshot.cgi`), Reolink (`/cgi-bin/api.cgi?cmd=Snap&channel=0`), Axis (`/axis-cgi/jpg/image.cgi`), ESP32-CAM (`/capture`). RTSP-only and cloud cameras work through [go2rtc](https://github.com/AlexxIT/go2rtc) (`/api/frame.jpeg?src=<cam>`); local JSON APIs work too.
- **Logins:** a token in the query, `http://user:pass@host/…`, or `username` / `password` (Basic or Digest). Never logged or returned; results show `http://***@host/path?***`.
- **Home network only:** the host must be, or resolve to, a private IPv4 address (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`).
- **Returns** `bytes`, `sha256`, `content_type`, `jpeg`, `http_status`, `fetch_ms`, and either a file on your VM (`delivery: "file"`, via `POST /fs/write`) or, when the VM refuses that to the gadget's token as it does today, `data_base64` (`delivery: "inline"`, up to 512 KB).
- **Options:** `max_bytes` (default 1 MiB, max 2 MiB), `timeout_ms` (default 15 s), `path` on the VM, `delivery` (`auto`, `file`, `inline`).
- **Bench test:** `>lan.fetch {"url":"http://…"}` on the USB console prints `@lan.fetch {…}`.

---

## Install Muse on a `WG1200` (safe dual-boot)

Muse goes into the second app slot (`ota_1`, `0x820000`) with its own NVS (`muse_nvs`, `0xF21000`). The Secure Boot V2 bootloader (`0x0`), certificates (`esp_secure_cert`, `0xD000`), WeatherXM NVS (`0xF000`), `factory` (`0x20000`), `ota_0` (`0x420000`) and SPIFFS (`0xC21000`) are never modified or erased.

### Web Flasher & Provisioner (`muse-flasher/`)

One page installs Muse beside WeatherXM, switches between them and sets Muse up. Open it in desktop **Chrome** or **Edge** and plug the `WG1200` in over USB-C; it talks to the gateway over **Web Serial** (flashing) and **Web Bluetooth** (setup), and a small Cloudflare Worker relays the `api.muse.ai` calls a browser can't make.

| Flash region | Holds | The flasher |
|---|---|---|
| `0x0` bootloader · `0xD000` certificates · `0xF000` NVS · `0x20000` `factory` | Secure Boot V2 and the station's WeatherXM identity | never writes it (blocked in the page) |
| `0x420000` `ota_0` | WeatherXM | writes a signed WeatherXM release, only if you pick one |
| `0x820000` `ota_1` | Muse | writes the signed Muse image |
| `0x13000` `otadata` | which slot boots | rewrites 8 KB to switch |
| `0xC000` partition table · `0xF21000` `muse_nvs` | Muse's settings and tokens | adds `muse_nvs` once, keeping every WeatherXM partition |

1. **Connect & inspect:** reads the partition table, `otadata` and each slot's app header.
2. **Install or switch:** checks the image's SHA-256 and RSA-3072 signature, writes the slot, MD5-verifies it on the chip, then switches `otadata`. If the slot already holds that build, it only switches `otadata`.
3. **SDK token:** after the reboot it sends `>sdk_token=mgst_…` over USB until Muse answers `@sdk_token ok`.
4. **Pair & provision:** see [Set up Muse over Bluetooth](#set-up-muse-over-bluetooth).

| Installing Muse into `ota_1` | The write guard and live flashing log |
|:---:|:---:|
| <img src=".github/images/muse-flasher-install.webp" width="440" alt="Muse × WeatherXM WG1200 Studio flashing Muse Gadget OS into ota_1 at 15%, with the Muse and WeatherXM firmware cards and the SDK token field below"> | <img src=".github/images/muse-flasher-flashing-log.webp" width="440" alt="The hardware safety guard summary above the live esptool log writing Muse into ota_1"> |
| **Wi-Fi, SDK token and 365-day device tokens** | **One-click provisioning and Muse's boot log** |
| <img src=".github/images/muse-flasher-provisioner.webp" width="440" alt="Token and BLE setup tab: Wi-Fi SSID and password with Show and Remember, SDK token with Write via USB Serial, node ID, Muse VM fields, the DevTools token snippet with a Copy button, and Mint and Verify buttons"> | <img src=".github/images/muse-flasher-boot-log.webp" width="440" alt="The seven provisioning steps and action buttons above the UART log of Muse booting on the WG1200 with its SDK token set"> |

Run it with `cd muse-flasher && npm install && npm run build && npm run preview` (http://localhost:8787). Pushes to `main` deploy it to Cloudflare Workers ([workflow](.github/workflows/muse-flasher-cloudflare.yml)); details in [`muse-flasher/README.md`](muse-flasher/README.md).

### Static web flasher (no install)

Open **[weatherxm.github.io/muse-gadget-sdk](https://weatherxm.github.io/muse-gadget-sdk/)** in Chrome or Edge (or run `python3 esp32/tools/muse/muse_setup_server.py` for `http://localhost:8099/web-flasher/`):

1. Paste your SDK token (`mgst_…`, 48 chars) from [gadgets.muse.ai](https://gadgets.muse.ai/settings/sdk-tokens).
2. Pick **WeatherXM WG1200 (D1 Wi-Fi Gateway — Safe Dual-Boot)**, click **Connect & install**, and choose **USB JTAG/serial debug unit** (`303a:1001`, ~20 s). The CH340 **USB Serial** port (`1a86:7523`) works too, with paced writes.
3. It writes only the partition table (`0xC000`, adds `muse_nvs`), `otadata` (`0x13000` → `ota_1`) and Muse (`0x820000`). Close the installer dialog and it sends your token over USB and reboots into Muse (`MuseGadget-XXXXXX`).

From the command line, [`esp32/tools/wg1200_dualboot.sh`](esp32/tools/wg1200_dualboot.sh) backs up, builds (versioned from [`devices/wxm-wg1200.version`](esp32/devices/wxm-wg1200.version)) and installs:

```bash
./esp32/tools/wg1200_dualboot.sh backup /dev/cu.usbserial-1110
WXM_SIGNING_KEY=/path/to/key.pem ./esp32/tools/wg1200_dualboot.sh build
WXM_SIGNING_KEY=/path/to/key.pem ./esp32/tools/wg1200_dualboot.sh install /dev/cu.usbserial-1110
```

### Set up Muse over Bluetooth

Both the Web Flasher & Provisioner (tab **2**) and the local provisioner at `http://localhost:8099/` (from `muse_setup_server.py`) run the same flow. A `muse.ai` web token (`s0:…`) expires in about an hour, so it's used once to mint a **365-day** device token pair (`access_token` + `refresh_token`) bound to the gateway's `homelink-xxxxxx` ID.

1. **Connect** over Web Bluetooth and pick `MuseGadget-XXXXXX` (swipe right on the screen first to turn Bluetooth on). The node ID fills in.
2. **Fill** your 2.4 GHz Wi-Fi (tick **Remember Wi-Fi password** to skip it next time) and SDK token. Locally, the token can come from the git-ignored [`muse_setup.secrets.json`](esp32/tools/muse/muse_setup.secrets.example.json) or `MUSE_SDK_TOKEN`.
3. **Get a web token:** copy the DevTools snippet, run it in the Console of a logged-in [muse.ai](https://muse.ai) tab (type `allow pasting` first if Chrome asks), and paste the result.
4. **Mint** once per device: minting again for the same node ID most likely revokes the pair already on it. Leave **Muse VM server** empty (`hatch.metaaivm.com`); `muse.ai` is the account API, not the VM server.
5. **1-Click Full Provision:** v5 pairing (P-256 ECDH + HKDF-SHA256 + AES-256-GCM), then **tap Confirm on the screen or briefly press the top button within 60 s**. It writes the VM and token to the Companion service (`muse_ble`) and sends Wi-Fi and the tokens in `provision_v2`. On `auth_ok` the gateway restarts and registers with your Muse VM.

> **Already set up?** A provisioned gateway refuses new pairings (`error_pairing_unavailable`). Hold the top button **5 s and release** (or click **Unpair / Reset Home Link**), then run it again.

### Back to WeatherXM

WeatherXM in `ota_0` and `factory` is untouched, so switching back takes seconds:

- **Touchscreen:** **Settings → WeatherXM**, then **Boot ota_0** (or **Boot factory**).
- **Top button:** hold **10 s** (see below). Muse's setup is kept.
- **Browser:** **Return WG1200 to WeatherXM** in either web flasher sends `>boot.weatherxm` over USB.
- **Command line** (works even when Muse isn't running): `./esp32/tools/wg1200_dualboot.sh boot-weatherxm /dev/cu.usbserial-1110`, and `boot-muse` to come back without reflashing.

### Top button

| Hold the top button (`GPIO38`) | What happens |
| --- | --- |
| Short press | Sleep / wake the display (double press: toggle BLE phone setup); during pairing, confirms it |
| 1.5 s | Beep, and the screen shows `HOLD 5S: RESET MUSE / 10S: WEATHERXM` (let go to cancel) |
| 5 s, then release | **Resets Muse**: unpairs Link, forgets Wi-Fi, clears the Muse token and VM, and restarts ready for 1-click provisioning |
| 10 s | **Reboots into stock WeatherXM**, keeping Muse's setup for `boot-muse` later |

The reset waits for the release, so holding on to 10 s never resets Muse.

---

## About the Muse Gadgets SDK (upstream)

> Everything above is specific to the WeatherXM `WG1200`. Everything below is the
> README of [facebookincubator/muse-gadget-sdk](https://github.com/facebookincubator/muse-gadget-sdk),
> which this repository forks, kept as it is so the fork can keep merging Meta's updates.


<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/images/muse-gadgets-dark.png">
    <img src=".github/images/muse-gadgets-light.png" width="900" alt="Muse gadgets: a Waveshare round AMOLED, an M5Stack StickS3, Muse Home Link, a Raspberry Pi and a Seeed reTerminal e-ink display">
  </picture>
</p>

Muse gadgets are open source devices you build yourself. Program an
off-the-shelf ESP32 board or set up a Raspberry Pi with our device SDKs, then
connect Muse to your displays, buttons, sensors, actuators, and whatever else
you've got lying on your workbench.

We open sourced the SDKs and firmware here. It's built by hackers, for hackers,
just for fun. Side effects of tinkering may include bricked boards, voided
warranties, brownouts, or bankruptcies. Proceed at your own risk!

|                                                                                  |                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**ESP32 Device SDK**](esp32)                                                    | Connect your ESP32 board to Muse through our open source SDK. Throw in a screen to show images, add audio in and out, or wire up other sensors.                                                               |
| [**Linux Device SDK**](linux)                                                    | Turn that spare Raspberry Pi or Linux box into a Muse gadget. Hack in your own commands to let Muse handle sysadmin chores or your Home Assistant setup.                                                      |
| [**Muse Gadgets Test**](android/musegadgetstest) ([iPhone](ios/musegadgetstest)) | Stream your phone's camera, or a clip, to an ESP32 gadget's screen over Wi-Fi: H.264 or VP8 decoded on the board, 30 fps on the round 466 px boards. [`protocols/VIDEO.md`](protocols/VIDEO.md) explains how. |

Before you flash or pair a gadget, get an
[SDK token](https://gadgets.muse.ai/settings/sdk-tokens) and review the
[Gadget SDK Terms](https://gadgets.muse.ai/sdk-terms). Every gadget needs a
token to pair.

ESP32 and Linux gadgets pair with the Muse app on iOS and Android, via
Settings > Devices. Turn on Developer mode there first, then look for devices
prefixed with "MuseGadget".
Each directory has a `README.md` to get started and an `AGENTS.md` for coding
agents like [Muse Code](https://developer.meta.com/ai/lp/muse-code/).

For battery-input power profiling, see the [porting recipe](esp32/docs/power/README.md).
The opt-in diagnostic core is board-neutral; boards supply its hooks and state
matrices, and [power_sweep.py](esp32/tools/power/power_sweep.py) drives the
USB-free sweep. The isolated diagnostic does not pair or need an SDK token;
fixture safety and explicit hardware authorization still come first, as the
[PPK2 rules](esp32/docs/power/ppk2.md) describe.

## Community

Meet other hackers who are building and customizing Muse gadgets in our
community [Discord](https://discord.gg/3bhjCkZdd6). Get inspired, support each
other, and share what you make.

## License

Muse Gadgets is licensed under the Apache License, Version 2.0, found in
[`LICENSE`](LICENSE), except for these third-party files, which keep their
upstream licenses:

| Path                                                                                                                     | Upstream                                                                                                                                                                    | License                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`esp32/components/minimp3/include/minimp3.h`](esp32/components/minimp3)                                                 | [lieff/minimp3](https://github.com/lieff/minimp3)                                                                                                                           | CC0-1.0, see [`LICENSE`](esp32/components/minimp3/LICENSE)                                                                                                                              |
| [`esp32/components/muse/boards/ostb_echoear_display_init.h`](esp32/components/muse/boards/ostb_echoear_display_init.h)   | [78/xiaozhi-esp32 ESP-VoCat panel sequence](https://github.com/78/xiaozhi-esp32/blob/0d576d3d4c049c6f55eaf879725dc23e516511b4/main/boards/espressif/esp-vocat/esp_vocat.cc) | MIT, retained in the file header                                                                                                                                                        |
| JD9853A initialization sequence in [`board_seeed_xiao_s3_147.c`](esp32/components/muse/boards/board_seeed_xiao_s3_147.c) | [Seeed-Studio/Seeed_GFX2](https://github.com/Seeed-Studio/Seeed_GFX2)                                                                                                       | MIT, see [`Seeed_GFX2.txt`](esp32/devices/licenses/Seeed_GFX2.txt)                                                                                                                      |
| [`esp32/main/pixel_font.c`](esp32/main/pixel_font.c)                                                                     | Adafruit GFX `glcdfont.c`                                                                                                                                                   | BSD-2-Clause, in the file header                                                                                                                                                        |
| [`esp32/components/muse/eink/fonts/montserrat.ttf`](esp32/components/muse/eink/fonts)                                    | Montserrat Medium, via LVGL v9.5.0                                                                                                                                          | SIL Open Font License 1.1                                                                                                                                                               |
| [`esp32/components/muse/eink/fonts/unscii.ttf`](esp32/components/muse/eink/fonts)                                        | unscii-8                                                                                                                                                                    | Public domain                                                                                                                                                                           |
| [`esp32/components/muse/eink/fonts/symbols.ttf`](esp32/components/muse/eink/fonts)                                       | Font Awesome 5 Free, via LVGL v9.5.0                                                                                                                                        | SIL Open Font License 1.1 (icons CC BY 4.0)                                                                                                                                             |
| [`esp32/main/epd_ssd1677.c`](esp32/main/epd_ssd1677.c)                                                                   | Seeed-reTerminal-E10xx-Firmware's SSD1677 refresh sequence                                                                                                                  | MIT, retained in the file header                                                                                                                                                        |
| [`esp32/components/tinyh264/src`](esp32/components/tinyh264)                                                             | the Android Open Source Project's H.264 decoder, via [udevbe/tinyh264](https://github.com/udevbe/tinyh264)                                                                  | Apache-2.0, AOSP's copyright, see [`LICENSE`](esp32/components/tinyh264/LICENSE)                                                                                                        |
| [`esp32/components/libvpx_vp8/src`](esp32/components/libvpx_vp8)                                                         | [libvpx](https://chromium.googlesource.com/webm/libvpx) v1.16.0's VP8 decoder, trimmed                                                                                      | BSD-3-Clause, the WebM Project authors' copyright, see [`LICENSE`](esp32/components/libvpx_vp8/LICENSE), with Google's patent grant in [`PATENTS`](esp32/components/libvpx_vp8/PATENTS) |

Dependencies fetched at build time are under their own licenses: ESP-IDF
components (into `esp32/managed_components/`), and the simulator's LVGL and
SDL (listed in [`esp32/simulator/THIRD_PARTY.md`](esp32/simulator/THIRD_PARTY.md)).

The Apache License does not cover the [Jollybot avatar](esp32/avatar).

Muse Gadgets Test's sample clips aren't in this repository: the app fetches a few
seconds of the Blender Foundation's open movies (CC BY 3.0) when one is
played, and shows their credits.

Muse Gadgets Test can use x264 (GPL-2.0) on the phone; this repository carries none
of its code. An APK or iPhone app you build with it is under the GPL
([`android/musegadgetstest/README.md`](android/musegadgetstest/README.md),
[`ios/musegadgetstest/README.md`](ios/musegadgetstest/README.md)).
