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

# Muse Gadgets — WeatherXM WG1200 Port

<p align="center">
  <img src=".github/images/wg1200-weather-cards-collage.jpeg" width="900" alt="Unique AI-generated 480x480 weather cards rendered on the WeatherXM WG1200 from live WS1001/WS1300 LoRa weather station telemetry">
</p>

## WeatherXM WG1200 (WXM M2) 2-Way Muse Appliance

This repository adds a full port of the **Muse ESP32 Device SDK** to the **WeatherXM WG1200** (`ESP32-S3-WROOM-1 N16R8`, 4.0" 480×480 ST7701S RGB565 touchscreen, Semtech SX1262 sub-GHz LoRa radio, Bosch BMP390 barometer, PCA9535 I/O expander). See the full hardware & setup guide in [`esp32/devices/wxm-wg1200.md`](esp32/devices/wxm-wg1200.md).

### What This Port Does

- **Non-Destructive Dual-Boot with Stock WeatherXM OS:** Installs RSA-3072 Secure Boot V2 signed Muse firmware into `ota_1` (`0x820000`) with an isolated `muse_nvs` partition (`0xF21000`). Your factory X.509 certificate (`esp_secure_cert`), encrypted WeatherXM NVS (`nvs` + `nvs_key`), `spiffs`, and `factory`/`ota_0` WeatherXM firmware remain 100% untouched. Switch back to WeatherXM anytime from the touchscreen (`Settings → WeatherXM`), by holding the top button for 5s, or remotely via Muse (`device.boot_weatherxm`).
- **Live Outdoor LoRa Weather Station Receiver (`WS1001` / `WS1300`):** Initializes the onboard **Semtech SX1262** (`SPI3`) in LoRa WeatherXM P2P mode (`SF7 / BW125 / CR 4/5`, configurable across `EU868`, `US915`, `AS923`) alongside the onboard **Bosch BMP390** barometer. Computes live outdoor temperature, humidity, wind speed, wind gust, wind direction, rolling 1-hour rain rate (`mm/h`), daily rain accumulation (`mm`), UV index, solar irradiance (`W/m²`), illuminance (`lx`), station battery status, and barometric pressure (`hPa`).
- **Generative 480×480 Weather Cards (Swipe Down on Muse Face):** Swipe down anywhere on the main Muse screen (or tap **Draw Weather Card** in `Settings → Weather`) to send live weather telemetry to your Muse VM with a randomized visual art style (Ukiyo-e woodblock, Studio Ghibli anime, Cyberpunk neon, Synthwave, 16-bit pixel RPG, Bauhaus poster, nautical chart, etc.). Muse generates a custom 480×480 card on the VM and streams it directly onto the WG1200 display via `display.draw_file`.
- **Touchscreen Quick Actions & Native On-Screen Captions:** Even without a microphone, one-tap prompts (**Hyperlocal Brief**, **Draw Weather Card**, and **LAN Smart Home Check**) send live weather context over the Noise `/chat/stream` session, page the sent prompt on-screen while the VM works, and stream Muse's reply directly onto the native Muse UI.
- **2-Way Cloud Muse VM → WG1200 Commands (`link.register` / `link.invoke`):**
  - `sensors.read` — Queries live outdoor (`WS1001`/`WS1300`) and indoor (`BMP390`) telemetry whenever you ask Muse about the weather from your phone or laptop.
  - `display.draw_file` / `display.draw_url` / `display.show_animation` — Renders 480×480 cards, charts, or animations onto the RGB565 panel.
  - `wg1200.notify` — Pushes a dismissible alert card onto the 480×480 screen and beeps the passive buzzer (`PCA9535 IO1_5`).
  - `device.discover` & Home-Network Tunnel — Scans the local LAN (ARP, mDNS, SSDP, NetBIOS) and bridges local HTTP smart-home APIs so Muse can pair live weather readings with actual devices on your network.
  - `device.boot_weatherxm` — Reboots the gateway back into stock WeatherXM OS (`ota_0` or `factory`).

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
