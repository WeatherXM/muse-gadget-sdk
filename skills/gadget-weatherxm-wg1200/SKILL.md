---
name: gadget-weatherxm-wg1200
description: >-
  Read live outdoor LoRa station telemetry and indoor barometric pressure from a paired WeatherXM
  WG1200 console (`sensors.read`), cross-check sky conditions with an approved LAN camera over
  Muse Home Link, and render 480x480 baseline JPEG cards (`display.draw_file`) or alert overlays
  (`wg1200.notify`).
---

# WeatherXM WG1200: Local Weather Station, Sky Checks, and 480x480 Display

Use this skill when the user's paired Muse Gadget is a WeatherXM WG1200 (`muse-gadget-wxm-wg1200`) with `sensors.read`, `display.draw_file`, and `wg1200.notify`.

## Identify the Device

- Confirm `link.register` / device capabilities list `muse-gadget-wxm-wg1200` (or `WeatherXM WG1200`) with `sensors.read`, `display.draw_file`, `wg1200.notify`, and `wg1200.boot_weatherxm`.
- Note that the WG1200 has a `480x480` touchscreen, a top button, and a passive alert buzzer, **but no microphone**. Users interact from the Muse app or from one-tap actions on the WG1200 touchscreen.

## Prerequisites

Read and follow the Home Link networking and safety rules in `~/docs/devices/home_link.md` whenever reaching another device on the WG1200's LAN.

- The WG1200 is online over Home Link (`sensors.read` and `display.draw_file` available). Onboard LoRa (`868`/`915` MHz) receives outdoor packets automatically from a nearby WeatherXM WS1001/WS1300 outdoor sensor array when present.
- If combining weather data with a LAN sky camera (for example via [`gadget-thingino-cameras`](../gadget-thingino-cameras/SKILL.md)), the user must approve that camera's IPv4 once in the Muse app. Because WG1200 has no on-device Home Link approval dialog, tell the user via chat (or a silent `wg1200.notify` card) if a touchscreen-triggered check is waiting on first-time camera approval in the Muse app.

## Workflow

1. **Read local microclimate (`sensors.read`).**
   - `outdoor`: `fresh` (`true` when a LoRa packet arrived recently), `age_s`, `temperature_c`, `humidity_pct`, `wind_speed_mps`, `wind_gust_mps`, `wind_dir_deg`, `rain_rate_mm_h`, `rain_daily_mm`, `uv_index`, `solar_wm2`, `battery_low`, `rssi_dbm`, `snr_db`, and `packets`.
   - `indoor`: `available`, `pressure_hpa`, and `temperature_c` from the console's Bosch BMP390. Use `indoor.pressure_hpa` for barometric pressure and pressure-trend analysis; treat `indoor.temperature_c` as console/enclosure temperature (warmed slightly by the LCD), not room ambient air.
   - Report active rain only when `rain_rate_mm_h > 0`; `rain_daily_mm` is cumulative since reset/day boundary and stays positive after rain ends.
2. **Optional LAN sky-camera verification.** When asked to inspect the sky or combine a camera view with station telemetry, fetch a snapshot from the user's approved LAN camera over the Home Link tunnel directly into the VM (preferring sub-stream JPEGs such as Thingino `/x/ch1.jpg?token=...` for speed, or `-rtsp_transport tcp` single-frame capture).
3. **Render onto the `480x480` screen (`display.draw_file`).**
   - Always output a **`480x480` baseline (non-progressive) JPEG** on the VM (`Pillow` with `progressive=False` or `ffmpeg`/`jpegtran` without `-progressive`) before calling `display.draw_file`.
   - Avoid progressive JPEGs (`JDR_FMT3` error on ESP32 ROM `tjpgd`) and `16:9` frames (`1920x1080` scales by `1/4` to a letterboxed `480x270` strip). Center-crop or compose a `480x480` square card on the VM first.
4. **Short alerts (`wg1200.notify`).** Use `wg1200.notify` (`message`, optional `title`, `beep_ms` `0-1000`, `duration_s`) for concise text alerts or audible weather warnings when requested. Use `beep_ms: 0` unless an audible chime is appropriate.

## Verify the Result

- Check `outdoor.fresh` and `outdoor.age_s` before stating current outdoor conditions; if `outdoor.fresh` is `false` or no packet has been received since boot, say the outdoor LoRa array is not currently reporting rather than substituting an internet forecast silently.
- Confirm `display.draw_file` returns `ok: true` with `width: 480`, `height: 480`.

## Limits

- Never invoke `wg1200.boot_weatherxm` unless the user explicitly asks to reboot the console out of Muse and back into stock WeatherXM firmware.
- Do not claim calibrated WMO station siting or sea-level pressure unless station elevation correction is applied (`indoor.pressure_hpa` is raw station pressure at the console's altitude).
- Do not poll LAN cameras or beep the buzzer repeatedly in the background without an explicit user schedule.

## Sources

- [WeatherXM D1 / WG1200 documentation](https://docs.weatherxm.com/)
- [Muse Gadget SDK ESP32 protocol and display commands](../../esp32/README.md)
