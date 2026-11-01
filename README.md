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
  <b>Give your personal AI agent real outdoor senses, eyes on the sky through your own cameras, a 480×480 desk canvas and a Sub-GHz LoRa radio—without losing your stock weather station OS.</b><br>
  Built for the <a href="https://weatherxm.com/stations/d1-wifi/"><b>WeatherXM D1 Wi-Fi Weather Station (<code>WS1001</code> + <code>WG1200</code>)</b></a> · <a href="esp32/devices/wxm-wg1200.md"><b>Hardware & Dual-Boot Guide →</b></a>
</p>

| [WeatherXM D1 (`WS1001` + `WG1200`)](https://weatherxm.com/stations/d1-wifi/) | `WG1200` Running Muse Gadget OS (`ota_1` Dual-Boot) |
| :---: | :---: |
| <a href="https://weatherxm.com/stations/d1-wifi/"><img src=".github/images/weatherxm-d1-station.jpg" width="410" alt="WeatherXM D1 Outdoor Solar Station and WG1200 4-inch Touchscreen Gateway"></a> | <img src=".github/images/wg1200-muse-desk.jpg" width="410" alt="WeatherXM WG1200 on desk running Muse Gadget firmware connected to Muse VM"> |
| Solar-powered 8-sensor outdoor array (`WS1001` / `WS1300`) transmitting every ~20s over private Sub-GHz LoRa P2P (up to 1 km) to the indoor `WG1200` 4.0" touchscreen console. | Paired over an encrypted Noise session to the Muse VM—answering live weather queries (`sensors.read`), fetching camera snapshots from the LAN (`lan.fetch`), and rendering generative `480×480` weather cards on swipe. |

---

## Why Turn a Weather Station into an AI Agent Appliance?

Most AI hardware prototypes are bare hobbyist PCBs dangling from a USB cable with no real-world sensors, while most commercial desk displays cost $180+ just to show static web widgets. Porting the Muse ESP32 SDK to the **[WeatherXM D1 (`WG1200`)](https://weatherxm.com/stations/d1-wifi/)** unlocks four practical capabilities in a single desktop enclosure:

1. **Physical Ground Truth + Eyes on Your Home Network (`sensors.read` + `lan.fetch`):**
   Cloud AI agents are typically blind to the actual microclimate outside your window—relying on coarse city forecasts while a 45 km/h gust hits your balcony or rain starts on the patio. The `WG1200` gives the agent live roof telemetry (`sensors.read`), finds the devices on your Wi-Fi (`device.discover`), and reads from them on its behalf (`lan.fetch`): a camera's view of the sky, a solar inverter's output, a smart-home hub's state. See [Eyes on the Sky](#eyes-on-the-sky-station--camera--cloud-analytics--collaborative-nowcasts).
2. **A Dynamic `480×480` Visual Canvas for AI & Automation (Beyond Static Numbers):**
   Instead of hardcoding every screen in firmware, the `WG1200` exposes dynamic `480×480` image rendering (`display.draw_file`, `display.draw_url`) and dismissible alert cards with audible buzzer chimes (`wg1200.notify`). Any personal AI agent, local home-automation hub, or custom script can turn live weather into bespoke infographics, storm alerts, camera snapshots fetched with `lan.fetch`, solar PV gauges, or generative artwork on the fly.
3. **Turnkey Dual-Boot Appliance (`Zero Risk to Stock Firmware`):**
   Rather than sacrificing an existing weather station to experiment with AI firmware, this port installs cleanly into the secondary firmware slot alongside your existing WeatherXM OS. Your station identity, settings, and stock WeatherXM firmware remain 100% untouched—reboot back and forth in seconds from the touchscreen, top button, or a remote agent command.
4. **Long-Range Sub-GHz LoRa Meets Personal AI:**
   Unlike Wi-Fi-only desk gadgets, the `WG1200` includes a built-in Sub-GHz LoRa radio alongside Wi-Fi and BLE. It receives solar-powered outdoor weather stations (`WS1001` and `WS1300`) through exterior walls up to 1 km away—and lays the foundation for bridging long-range outdoor field sensors and peer-to-peer LoRa mesh telemetry directly into personal AI workflows.

---

## Eyes on the Sky: Station + Camera → Cloud Analytics → Collaborative Nowcasts

### What's new: a cloud agent that can see your sky

A cloud AI agent normally can't see anything on your home network: its VM has no route to your LAN, and the usual workarounds are port forwarding, a vendor's camera cloud, or exposing the camera to the internet. With `lan.fetch`, the `WG1200` does the fetching for it. Muse asks the gateway for `http://<camera>/snapshot.jpg`, the gateway GETs it on the LAN and returns the JPEG over the encrypted session it already holds to Muse's VM. Nothing listens for inbound connections, and no ports are opened.

What makes that more than a webcam viewer is where it sits: the same device holds **time-aligned, co-located ground truth** from the rooftop station. One agent turn can combine:

- a frame of the sky or the garden from any camera with an HTTP snapshot URL (Thingino, Hikvision, Dahua, Reolink, Axis, ESP32-CAM, or RTSP cameras through go2rtc), and
- the outdoor readings from the station's latest packet, at most ~20 s old: wind speed, gust and direction, rain rate, solar irradiance, UV, temperature, humidity and pressure (`sensors.read`).

### Cloud analytics on the frame and the telemetry

Muse's VM can run code and vision models on every frame, so the analysis happens in the cloud, not on the ESP32:

- **Cross-checked conditions:** "overcast" from the image against the irradiance drop, "raining" against rain rate and drops on the lens, fog or low visibility against humidity and temperature.
- **Events the sensors miss:** snow on the ground, hail, a storm cell building on the horizon, smoke, a frozen or misaligned sensor.
- **Labelled data for free:** every frame stored with its sensor readings and timestamp becomes training data for local sky and precipitation models.
- **Results back on the desk:** a `480×480` card (`display.draw_file`), an alert with a chime (`wg1200.notify`), or a message on your phone.

### Many stations, many agents: collaborative nowcasting

WeatherXM already runs a network of community weather stations. Give each one a camera and its own agent, and the agents can share what they see:

- **Cloud motion:** timestamped frames from neighbouring cameras give cloud-shadow direction and speed, and two cameras at known positions can triangulate cloud height.
- **Rain fronts:** rain-rate onset at upwind stations, with wind direction, gives an arrival estimate for the next street over.
- **Solar output:** cloud-shadow tracks plus irradiance give short-term solar forecasts for nearby PV owners.

Combined, those are **hyperlocal nowcasts (0–60 minutes)** at street scale, built from sensors and cameras on the ground rather than radar or satellite pixels.

### Today vs next

| Works today on the `WG1200` | Next steps (not built yet) |
|---|---|
| Muse fetches a camera frame through the gateway (`lan.fetch`), tested with a Thingino camera | Agents discovering and talking to each other (rendezvous) |
| Live station telemetry from the same device (`sensors.read`) | Signed frames and readings, so other agents can trust where data came from |
| Analysis in Muse's VM, results drawn on the gateway's screen | Multi-camera cloud tracking, stereo cloud height and the nowcast service itself |

See [Cameras & home-network devices](#cameras--home-network-devices-lanfetch) for how to call `lan.fetch`.

---

## Highlights & Bells and Whistles (`wxm-wg1200`)

- **Live Outdoor Weather Station + Rain Tracking:**
  - Receives real-time outdoor temperature, humidity, wind speed, wind gusts, wind direction, UV index, solar irradiance, and light directly from your rooftop station (`WS1001` / `WS1300`), paired with indoor barometric pressure (`hPa`).
  - Tracks live **Rain Rate (`mm/h`)** and **Daily Rain Accumulation (`mm`)** across reboots, while automatically locking onto your own outdoor station so neighboring stations never mix into your data.
- **Swipe-Down Generative `480×480` Weather Cards:**
  - **Swipe down anywhere on the main Muse face** (or over an active card, or tap **Draw Weather Card** in `Settings → Weather`) to turn your live outdoor weather into a one-of-a-kind `480×480` artwork.
  - Each swipe pairs your exact outdoor conditions with a randomized visual style (*Ukiyo-e woodblock*, *Studio Ghibli anime*, *Art Deco*, *Synthwave*, *16-bit pixel RPG*, *Bauhaus poster*, *Watercolor field notes*, *Nautical chart*, and more) and streams the finished card straight to the screen.
- **No-Mic Touchscreen Quick Actions & Live On-Screen Replies:**
  - Built for a mic-less desk console: one-tap touch actions (**Hyperlocal Brief**, **Draw Weather Card**, **LAN Smart Home Check**) automatically include your live outdoor weather and send the request to Muse.
  - Displays your prompt on-screen while Muse is thinking, then streams Muse's answer right across the `480×480` display.
- **2-Way Muse ↔ `WG1200` Smart-Home & Display Tools:**
  - `sensors.read` — Lets you ask Muse about your exact rooftop weather, wind gusts, or rain from your phone or laptop at any time.
  - `display.draw_file` / `display.draw_url` / `display.show_animation` — Draws custom `480×480` cards, charts, or images onto the screen on demand.
  - `wg1200.notify` — Pushes a dismissible alert card onto the screen with an optional audible buzzer chime.
  - `device.discover` — Discovers devices on your home Wi-Fi (ARP, mDNS, SSDP, WS-Discovery and more), so Muse knows what's there.
  - `lan.fetch` — Fetches any URL on your home network that Muse's cloud VM can't reach, such as an IP camera's JPEG snapshot or a local device's JSON API, and hands the bytes to Muse for cloud analytics (see [Cameras & home-network devices](#cameras--home-network-devices-lanfetch)).
  - `device.boot_weatherxm` — Reboots the console back into stock WeatherXM OS whenever you want.
- **One Top Button, Two Long Holds:** hold **5 s and release** to reset Muse for a fresh 1-click setup, or keep holding to **10 s** to reboot into stock WeatherXM with Muse's setup kept (see [Top button](#top-button)).
- **1-Click Browser Web Flasher, Web Bluetooth Provisioner & Non-Destructive Dual-Boot:**
  - Includes a browser-based **Web Flasher** ([`web-flasher/`](web-flasher/)) with the latest RSA-3072 signed `muse-gadget.bin` pre-packaged for safe dual-boot installation, plus the **Full Web Bluetooth Provisioner** ([`esp32/tools/muse/muse_full_setup.html`](esp32/tools/muse/muse_full_setup.html)) for 1-click 365-day token minting and Wi-Fi/VM pairing. Full hardware & protocol reference in **[`esp32/devices/wxm-wg1200.md`](esp32/devices/wxm-wg1200.md)**.

---

## Quick Start: Flash & Provision a New WeatherXM `WG1200` (Safe Dual-Boot)

The `WG1200` dual-boot layout installs Muse into the secondary `ota_1` slot (`0x820000`) and uses an isolated NVS partition (`muse_nvs` at `0xF21000`). **Your original WeatherXM firmware (`factory` at `0x20000` and `ota_0` at `0x420000`), Secure Boot V2 bootloader (`0x0`), hardware certificates (`esp_secure_cert` at `0xD000`), NVS (`0xF000`), and SPIFFS (`0xC21000`) are never modified or erased.**

### 1. Start the Local Web Flasher & Provisioning Server

From the repository root, start the local helper server (serves both the **Web Flasher** and the **Web Bluetooth Provisioner** + `api.muse.ai` CORS proxy on port `8099`):

```bash
python3 esp32/tools/muse/muse_setup_server.py
```

* **Web Flasher (USB Serial):** `http://localhost:8099/web-flasher/`
* **Web Bluetooth Provisioner (BLE + 365-Day Token Minting):** `http://localhost:8099/`

---

### 2. Flash a New `WG1200` (Without Touching Stock WeatherXM Firmware)

1. Plug your `WG1200` into your computer via USB-C and open **`http://localhost:8099/web-flasher/`** in **Google Chrome** or **Edge**.
2. **Step 1 (SDK Token):** Paste your Muse SDK token (`mgst_...`, 48 chars) from [`https://gadgets.muse.ai/settings/sdk-tokens`](https://gadgets.muse.ai/settings/sdk-tokens).
3. **Step 2 (Install):** Ensure **WeatherXM WG1200 (D1 Wi-Fi Gateway — Safe Dual-Boot)** is selected, click **Connect & install**, and choose the WG1200 USB-Serial port (`wchusbserial*` / `usbserial*`, USB ID `1a86:7523`).
4. ESP Web Tools writes **only** three non-destructive regions using the latest RSA-3072 signed binary (`web-flasher/firmware/wxm-wg1200/`):
   * `0xC000` — `partition-table.bin` (adds `muse_nvs` at `0xF21000` while keeping all stock WeatherXM partitions identical)
   * `0x13000` — `otadata_ota1.bin` (selects `ota_1` as the active boot slot)
   * `0x820000` — `muse-gadget.bin` (RSA-3072 Secure Boot V2 signed Muse firmware in `ota_1`)
5. When flashing finishes, **close the installer dialog** — the Web Flasher automatically sends `>sdk_token=mgst_...` over USB serial, stores it in `muse_nvs`, and reboots the gateway into Muse (`MuseGadget-XXXXXX`).

> **CLI Alternative:** You can also back up and flash from the terminal using [`esp32/tools/wg1200_dualboot.sh`](esp32/tools/wg1200_dualboot.sh):
> ```bash
> ./esp32/tools/wg1200_dualboot.sh backup /dev/cu.usbserial-1110
> WXM_SIGNING_KEY=/path/to/key.pem ./esp32/tools/wg1200_dualboot.sh build
> WXM_SIGNING_KEY=/path/to/key.pem ./esp32/tools/wg1200_dualboot.sh install /dev/cu.usbserial-1110
> ```

---

### 3. Provision the `WG1200` with a Permanent 365-Day Token (Web Bluetooth)

Because a raw web session token (`s0:...`) from `muse.ai` expires after ~1 hour, the provisioner uses it **once** to mint a dedicated **365-day (`31,536,000s`)** device token pair (`access_token` + `refresh_token`) bound to your WG1200's hardware ID (`homelink-xxxxxx`):

1. Open **`http://localhost:8099/`** in **Google Chrome** or **Edge** (desktop: Web Bluetooth).
2. In **Section 1**, click **Connect ESP32 via Web Bluetooth** and select `MuseGadget-XXXXXX`. The page reads the device's telemetry and auto-fills the **Node ID** (`homelink-xxxxxx`, the lowercase hex suffix of `MuseGadget-XXXXXX`).
3. In **Section 2A**, enter your **2.4 GHz Wi-Fi SSID & Password** (tick **Remember Wi-Fi password in this browser** to skip it next time) and your **SDK Token (`mgst_...`)**. To have the token filled in for you, put it in the git-ignored `esp32/tools/muse/muse_setup.secrets.json` (copy [`muse_setup.secrets.example.json`](esp32/tools/muse/muse_setup.secrets.example.json)) or set `MUSE_SDK_TOKEN` before starting the server.
4. In **Section 2B**:
   * Click **Copy DevTools Token Snippet**, switch to a logged-in [`https://muse.ai`](https://muse.ai) tab, open the DevTools Console (`F12` → Console), paste the snippet and press **Enter** (type `allow pasting` first if Chrome asks). It copies your web `access_token` to the clipboard.
   * Paste it into **Web User Access Token** and click **Mint 365-Day Device Tokens Now** (`POST https://api.muse.ai/device_token/mint`). Mint **once per device**: minting again for the same Node ID most likely revokes the pair already on the device.
   * Leave **Muse VM server** empty: the firmware default (`hatch.metaaivm.com`) is right. `muse.ai` is the account API, not the VM server.
5. In **Section 3**, click **1-Click Full Provision (Home Link + Companion)**. It runs the `v=5` pairing (P-256 ECDH + HKDF-SHA256 + AES-256-GCM), **asks you to tap "Confirm" on the WG1200 touchscreen within 60 s**, writes the Muse VM and token to the Companion service (`muse_ble`), then sends Wi-Fi and the tokens in `provision_v2`.
6. Within a few seconds the page shows `wifi_connected` and `auth_ok`, the WG1200 restarts, registers with your Muse VM (`link.register`) and is ready for touch queries, live LoRa weather (`sensors.read`), generative `480×480` weather cards and `lan.fetch`.

> **Already set up?** A provisioned WG1200 refuses new pairings (`error_pairing_unavailable`). Hold the top button **5 s and release** (or click **Unpair / Reset Home Link**) to reset Muse, then run 1-click again.

---

### 4. How to Return to Stock WeatherXM Firmware Anytime

Because the stock WeatherXM OS in `ota_0` (`0x420000`) and `factory` (`0x20000`) is untouched, you can switch back to WeatherXM in seconds using any of **4 methods**:

1. **On the WG1200 Touchscreen:** Tap **Settings (gear icon) → WeatherXM**, then tap **`Boot ota_0`** (or **`Boot factory`**) and confirm.
2. **Physical Top Button (10-Second Hold):** Press and hold the **top physical button (`GPIO38`) for 10 seconds** (beeps at 1.5 s and 5 s, then reboots straight into WeatherXM at 10 s). Muse's setup is kept. Releasing between 5 and 10 s instead resets Muse (see [Top button](#top-button)).
3. **Browser Web Flasher (`http://localhost:8099/web-flasher/`):** Expand **WeatherXM WG1200 — Return to WeatherXM**, click **Return WG1200 to WeatherXM**, and select the USB port (sends `>boot.weatherxm` over USB serial at `115200` baud).
4. **CLI Script (works even if Muse is not running):**
   ```bash
   ./esp32/tools/wg1200_dualboot.sh boot-weatherxm /dev/cu.usbserial-1110
   ```
   *(To switch back to Muse later without reflashing, run `./esp32/tools/wg1200_dualboot.sh boot-muse /dev/cu.usbserial-1110`.)*

---

### Top button

| Hold the top button (`GPIO38`) | What happens |
|---|---|
| Short press | Sleep / wake the display (double press: toggle BLE phone setup) |
| 1.5 s | Beep, and the screen shows `HOLD 5S: RESET MUSE / 10S: WEATHERXM` (let go to cancel) |
| 5 s, then release | **Resets Muse**: unpairs Link, forgets Wi-Fi, clears the Muse token and VM, and restarts ready for 1-click provisioning |
| 10 s | **Reboots into stock WeatherXM**, keeping Muse's setup for `boot-muse` later |

The reset waits for the release, so holding on to 10 s never resets Muse.

---

### Cameras & home-network devices (`lan.fetch`)

Muse runs in a cloud VM and can't reach your home network. The WG1200 can: `lan.fetch` has it GET a URL on your LAN and hand the bytes to Muse. Ask Muse something like *"fetch my camera's snapshot with lan.fetch and show it with display.draw_file"*.

```json
{"url": "http://192.168.1.20/x/ch1.jpg?token=…"}
```

- **Any camera with an HTTP snapshot URL**, no particular firmware: Thingino (`/x/ch1.jpg?token=…`), Hikvision (`/ISAPI/Streaming/channels/101/picture`), Dahua and Amcrest (`/cgi-bin/snapshot.cgi`), Reolink (`/cgi-bin/api.cgi?cmd=Snap&channel=0`), Axis (`/axis-cgi/jpg/image.cgi`), ESP32-CAM (`/capture`). RTSP-only and cloud cameras work through a bridge such as [go2rtc](https://github.com/AlexxIT/go2rtc) (`/api/frame.jpeg?src=<cam>`), and local JSON APIs work too.
- **Logins:** a token in the query, `http://user:pass@host/…`, or the `username` and `password` parameters (Basic or Digest). They are never logged or returned; results show the URL as `http://***@host/path?***`.
- **Home network only:** the host must be, or resolve to, a private IPv4 address (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`).
- **What comes back:** `bytes`, `sha256`, `content_type`, `jpeg`, `http_status`, `fetch_ms`, and either a file on your VM (`delivery: "file"`, over `POST /fs/write`) or, when the VM refuses that to the gadget's token as it does today, the body as `data_base64` (`delivery: "inline"`, up to 512 KB).
- **Options:** `max_bytes` (default 1 MiB, up to 2 MiB), `timeout_ms` (default 15 s), `path` on the VM, `delivery` (`auto`, `file`, `inline`).
- **Bench test over USB:** `>lan.fetch {"url":"http://…"}` on the serial console runs the same command and prints `@lan.fetch {…}`.

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
