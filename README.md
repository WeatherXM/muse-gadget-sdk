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

# Muse Gadgets — WeatherXM D1 (`WG1200`) Physical AI & Weather Appliance

<p align="center">
  <img src=".github/images/wg1200-weather-cards-collage.jpeg" width="900" alt="Unique AI-generated 480x480 weather cards rendered on the WeatherXM WG1200 from live WS1001/WS1300 LoRa weather station telemetry">
</p>

<p align="center">
  <b>Give your personal AI agent real outdoor senses, a 480×480 desk canvas, a Sub-GHz LoRa radio, and a local smart-home bridge—without losing your stock weather station OS.</b><br>
  Built for the <a href="https://weatherxm.com/stations/d1-wifi/"><b>WeatherXM D1 Wi-Fi Weather Station (<code>WS1001</code> + <code>WG1200</code>)</b></a> · <a href="esp32/devices/wxm-wg1200.md"><b>Hardware & Dual-Boot Guide →</b></a>
</p>

| [WeatherXM D1 (`WS1001` + `WG1200`)](https://weatherxm.com/stations/d1-wifi/) | `WG1200` Running Muse Gadget OS (`ota_1` Dual-Boot) |
| :---: | :---: |
| <a href="https://weatherxm.com/stations/d1-wifi/"><img src=".github/images/weatherxm-d1-station.jpg" width="410" alt="WeatherXM D1 Outdoor Solar Station and WG1200 4-inch Touchscreen Gateway"></a> | <img src=".github/images/wg1200-muse-desk.jpg" width="410" alt="WeatherXM WG1200 on desk running Muse Gadget firmware connected to Muse VM"> |
| Solar-powered 8-sensor outdoor array (`WS1001` / `WS1300`) transmitting every ~20s over private Sub-GHz LoRa P2P (up to 1 km) to the indoor `WG1200` 4.0" touchscreen console. | Paired over an encrypted Noise session to the Muse VM—answering live weather queries (`sensors.read`), bridging local LAN devices, and rendering generative `480×480` weather cards on swipe. |

---

## Why Turn a Weather Station into an AI Agent Appliance?

Most AI hardware prototypes are bare hobbyist PCBs dangling from a USB cable with no real-world sensors, while most commercial desk displays cost $180+ just to show static web widgets. Porting the Muse ESP32 SDK to the **[WeatherXM D1 (`WG1200`)](https://weatherxm.com/stations/d1-wifi/)** unlocks four practical capabilities in a single desktop enclosure:

1. **Physical Ground Truth → Local Smart-Home Action (`Sensors + LAN Tunnel`):**
   Cloud AI agents are typically blind to the actual microclimate outside your window—relying on coarse city forecasts while a 45 km/h gust hits your balcony or rain starts on the patio. By combining live roof telemetry (`sensors.read`) with the built-in local network discovery and HTTP tunnel (`CONFIG_HOMEHUB_TUNNEL` + `device.discover`), an agent can correlate real wind gusts, tipping-bucket rain rate, barometric pressure drops, and solar irradiance (`W/m²`) directly with local smart-home hubs, relays, awnings, irrigation controllers, HVAC, and media devices on your Wi-Fi.
2. **A Dynamic `480×480` Visual Canvas for AI & Automation (Beyond Static Numbers):**
   Instead of hardcoding every C/LVGL screen in firmware, the `ESP32-S3-WROOM-1 (16 MB Flash / 8 MB Octal PSRAM)` exposes hardware-accelerated `480×480` JPEG/RGB565 rendering (`display.draw_file`, `display.draw_url`) and dismissible top-layer alert cards with passive buzzer tones (`wg1200.notify`). Any personal AI agent, local home-automation hub, or custom script can synthesize live telemetry into bespoke infographics, storm alerts, doorbell/camera snapshots, solar PV gauges, or generative artwork on the fly.
3. **Turnkey Dual-Boot Appliance (`Zero Risk to Stock Firmware`):**
   Rather than sacrificing an existing weather station to experiment with AI firmware, this port installs RSA-3072 Secure Boot V2 signed firmware into the secondary OTA slot (`ota_1` at `0x820000`) with an isolated `muse_nvs` partition (`0xF21000`). Your factory X.509 identity (`esp_secure_cert`), encrypted WeatherXM NVS (`nvs` + `nvs_key`), `spiffs`, and stock WeatherXM OS (`factory` / `ota_0`) remain 100% untouched—reboot back and forth in 5 seconds from the touchscreen, top button, or a remote agent command.
4. **Long-Range Sub-GHz LoRa (`SX1262`) Meets Personal AI:**
   Unlike Wi-Fi-only desk gadgets, the `WG1200` integrates a Semtech `SX1262` sub-GHz radio (`868 / 915 / 923 MHz`) alongside Wi-Fi and BLE. It decodes solar-powered outdoor weather stations (`WS1001` and `WS1300`) through exterior walls up to 1 km away—and lays the foundation for bridging long-range sub-GHz field sensors and peer-to-peer LoRa mesh telemetry directly into personal AI workflows.

---

## Highlights & Bells and Whistles (`wxm-wg1200`)

- **Authentic SX1262 WeatherXM LoRa P2P Receiver & Rain Engine (`wg1200_weather.c`):**
  - Native `500 kHz BW`, `SF7/SF9..SF12` preamble scan, `CR 4/5`, `SyncWord 0x12` receiver across `EU868`, `US915`, `AS923`, `AU915`, `KR920`, and `IN865`.
  - Decodes both **`WS1001`** (22-byte frame, magic `0x5A`, XOR key `0xA3`, CRC16-MODBUS) and **`WS1300`** (17-byte frame, preamble `0x35/0x36/0x37`, XOR checksum) outdoor stations alongside the onboard **Bosch BMP390** indoor barometer (`hPa`).
  - Computes tipping-bucket **Rain Rate (`mm/h`)** from tip intervals (with automatic decay) and **Daily Rain (`mm`)** accumulated since local midnight, persisted across reboots in `RTC_NOINIT_ATTR` + NVS (`wx_daily`).
  - **Primary Station Lock:** Automatically locks onto your paired station ID (`device_id` in NVS, or first valid station with a 600s fallback) so neighboring stations never pollute your telemetry or trigger false rain tips.
- **Swipe-Down Generative `480×480` Weather Cards:**
  - **Swipe down anywhere on the main Muse face** (or over an active card, or tap **Draw Weather Card** in `Settings → Weather`) to send live outdoor telemetry to your Muse VM paired with a hardware-RNG randomized art style (12 styles including *Ukiyo-e woodblock*, *Studio Ghibli anime*, *Art Deco*, *Synthwave*, *16-bit pixel RPG*, *Bauhaus poster*, *Watercolor field notes*, *Nautical chart*, etc.) and creative twist.
  - The Muse VM generates a one-of-a-kind `480×480` card reflecting your exact outdoor conditions and streams it onto the screen via `display.draw_file`.
- **No-Mic Touchscreen Quick Actions & Live Prompt Paging (`muse_hatch_ui_text_turn`):**
  - Designed specifically for a mic-less desk console: one-tap touch actions (**Hyperlocal Brief**, **Draw Weather Card**, **LAN Smart Home Check**) inject live outdoor weather telemetry and send a typed turn over `/chat/stream`.
  - Pages your sent prompt on-screen while `THINKING` until the first character of the reply arrives (`!has_reply_text()`), then pages Muse's streaming response across the `480×480` display.
- **2-Way Cloud Muse VM ↔ `WG1200` Command Surface (`link.register` / `link.invoke`):**
  - `sensors.read` — Returns live outdoor (`WS1001`/`WS1300`) and indoor (`BMP390`) weather metrics with per-sensor `age_s` and LoRa radio link stats (`RSSI`, `SNR`, station ID, packet counters).
  - `display.draw_file` / `display.draw_url` / `display.show_animation` — Streams `480×480` baseline JPEGs or raw RGB565 frames directly from the Muse VM (`/fs/raw/...`) or HTTP URLs onto the screen.
  - `wg1200.notify` — Renders a dismissible LVGL top-layer alert card (`title`, `message`, `duration_s`) and beeps the passive SMD buzzer (`PCA9535 IO1_5`).
  - `device.discover` & Home-Network Tunnel — Scans the local LAN (`ARP`, `mDNS`, `SSDP`, `NetBIOS`) and tunnels local HTTP requests so Muse can act on your smart-home devices using live weather context.
  - `device.boot_weatherxm` — Reboots the console back into stock WeatherXM OS (`ota_0` or `factory`).
- **Web Bluetooth + Web Serial Setup Console (`esp32/tools/muse/muse_full_setup.html`):**
  - Browser-based provisioning tool + local proxy (`muse_setup_server.py`) for one-click Wi-Fi setup, 365-day device token minting, and HomeLink pairing.
  - Full build, dual-boot backup/install (`wg1200_dualboot.sh`), schematic pinout, and partition layout documented in **[`esp32/devices/wxm-wg1200.md`](esp32/devices/wxm-wg1200.md)**.

---

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

| | |
|---|---|
| [**ESP32 Device SDK**](esp32) | Connect your ESP32 board to Muse through our open source SDK. Throw in a screen to show images, add audio in and out, or wire up other sensors. |
| [**Linux Device SDK**](linux) | Turn that spare Raspberry Pi or Linux box into a Muse gadget. Hack in your own commands to let Muse handle sysadmin chores or your Home Assistant setup. |
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

| Path | Upstream | License |
|---|---|---|
| [`esp32/components/minimp3/include/minimp3.h`](esp32/components/minimp3) | [lieff/minimp3](https://github.com/lieff/minimp3) | CC0-1.0, see [`LICENSE`](esp32/components/minimp3/LICENSE) |
| [`esp32/components/muse/boards/ostb_echoear_display_init.h`](esp32/components/muse/boards/ostb_echoear_display_init.h) | [78/xiaozhi-esp32 ESP-VoCat panel sequence](https://github.com/78/xiaozhi-esp32/blob/0d576d3d4c049c6f55eaf879725dc23e516511b4/main/boards/espressif/esp-vocat/esp_vocat.cc) | MIT, retained in the file header |
| JD9853A initialization sequence in [`board_seeed_xiao_s3_147.c`](esp32/components/muse/boards/board_seeed_xiao_s3_147.c) | [Seeed-Studio/Seeed_GFX2](https://github.com/Seeed-Studio/Seeed_GFX2) | MIT, see [`Seeed_GFX2.txt`](esp32/devices/licenses/Seeed_GFX2.txt) |
| [`esp32/main/pixel_font.c`](esp32/main/pixel_font.c) | Adafruit GFX `glcdfont.c` | BSD-2-Clause, in the file header |
| [`esp32/components/muse/eink/fonts/montserrat.ttf`](esp32/components/muse/eink/fonts) | Montserrat Medium, via LVGL v9.5.0 | SIL Open Font License 1.1 |
| [`esp32/components/muse/eink/fonts/unscii.ttf`](esp32/components/muse/eink/fonts) | unscii-8 | Public domain |
| [`esp32/components/muse/eink/fonts/symbols.ttf`](esp32/components/muse/eink/fonts) | Font Awesome 5 Free, via LVGL v9.5.0 | SIL Open Font License 1.1 (icons CC BY 4.0) |
| [`esp32/main/epd_ssd1677.c`](esp32/main/epd_ssd1677.c) | Seeed-reTerminal-E10xx-Firmware's SSD1677 refresh sequence | MIT, retained in the file header |
| [`esp32/components/tinyh264/src`](esp32/components/tinyh264) | the Android Open Source Project's H.264 decoder, via [udevbe/tinyh264](https://github.com/udevbe/tinyh264) | Apache-2.0, AOSP's copyright, see [`LICENSE`](esp32/components/tinyh264/LICENSE) |
| [`esp32/components/libvpx_vp8/src`](esp32/components/libvpx_vp8) | [libvpx](https://chromium.googlesource.com/webm/libvpx) v1.16.0's VP8 decoder, trimmed | BSD-3-Clause, the WebM Project authors' copyright, see [`LICENSE`](esp32/components/libvpx_vp8/LICENSE), with Google's patent grant in [`PATENTS`](esp32/components/libvpx_vp8/PATENTS) |

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
