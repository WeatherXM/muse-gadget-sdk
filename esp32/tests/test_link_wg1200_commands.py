# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ESP32_DIR = Path(__file__).resolve().parents[1]
MAIN_DIR = ESP32_DIR / "main"
CJSON_DIR = Path(
    os.environ.get(
        "CJSON_SOURCE_DIR",
        ESP32_DIR / "managed_components/espressif__cjson/cJSON",
    )
)


def extract_c_block(source: str, anchor: str) -> str:
    start = source.index(anchor)
    brace = source.index("{", start)
    depth = 0
    in_string = False
    escape = False
    i = brace
    while i < len(source):
        ch = source[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return source[start : i + 1]
        i += 1
    raise ValueError(f"Unclosed block for {anchor}")


class LinkWg1200CommandsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cxx = shutil.which("c++") or shutil.which("clang++") or shutil.which("g++")
        cc = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
        if not cxx or not cc or not (CJSON_DIR / "cJSON.c").exists():
            raise unittest.SkipTest("Host C/C++ compiler or cJSON not available")

        noise_src = (MAIN_DIR / "noise_control.cpp").read_text(encoding="utf-8")
        app_src = (MAIN_DIR / "app.c").read_text(encoding="utf-8")

        string_param_fn = extract_c_block(noise_src, "static cJSON *string_param(")
        int_param_fn = extract_c_block(noise_src, "static cJSON *int_param(")
        row_params_fn = extract_c_block(noise_src, "static cJSON *row_params(")
        add_command_fn = extract_c_block(noise_src, "static void add_command(")
        add_meta_fn = extract_c_block(
            noise_src, "static void add_register_metadata_string("
        )
        build_register_fn = extract_c_block(
            noise_src, "static char *build_register_json("
        )
        command_error_fn = extract_c_block(app_src, "static cJSON *command_error(")
        wg1200_notify_fn = extract_c_block(
            app_src, "static cJSON *wg1200_notify_command("
        )
        on_ws_command_fn = extract_c_block(app_src, "static cJSON *on_ws_command(")

        wg1200_branch_match = re.search(
            r"#if CONFIG_MUSE_BOARD_WXM_WG1200\s+if \(strcmp\(command, \"sensors\.read\"\).*?#endif",
            on_ws_command_fn,
            flags=re.DOTALL,
        )
        assert wg1200_branch_match is not None, "WG1200 branch missing in on_ws_command"
        wg1200_branch = wg1200_branch_match.group(0)

        harness_cpp = f"""
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern "C" {{
#include "cJSON.h"
}}

#define CONFIG_MUSE_BOARD_WXM_WG1200 1
#define CONFIG_HOMEHUB_DISPLAY_COMMANDS 1
#define CONFIG_HOMEHUB_LED_BACKEND_MUSE 1
#define CONFIG_HOMEHUB_TUNNEL 1

typedef uint32_t noise_ctrl_session_generation_t;
typedef struct {{
    const char *version;
}} esp_app_desc_t;

static const char *s_node_id = "homelink-e3efc0";
static const char *s_display_name = "WeatherXM WG1200";
static char s_wifi_ssid[33] = "WeatherNet";
static char s_register_req_id[40] = {{0}};
static bool s_speaker_on = true;
static bool s_ui_ready = true;
static int s_last_beep_ms = 0;
static int s_last_duration_s = -1;
static char s_last_title[128] = {{0}};
static char s_last_msg[256] = {{0}};

static void copy_wifi_ssid(char *dst, size_t cap) {{
    snprintf(dst, cap, "%s", s_wifi_ssid);
}}
static void make_uuid(char *dst, size_t cap) {{
    snprintf(dst, cap, "00000000-0000-4000-8000-000000e3efc0");
}}
static const esp_app_desc_t *esp_app_get_description(void) {{
    static const esp_app_desc_t desc = {{ "0.1.2-wg1200" }};
    return &desc;
}}
static bool led_status_display_info(int *w, int *h) {{
    *w = 480;
    *h = 480;
    return true;
}}
static int led_status_display_bits(void) {{ return 16; }}
static bool ota_is_enabled(void) {{ return true; }}

static bool muse_settings_speaker_on(void) {{ return s_speaker_on; }}
static void wg1200_buzzer_beep(uint32_t duration_ms) {{ s_last_beep_ms = (int)duration_ms; }}
static bool muse_ui_notify_show(const char *title, const char *message, int duration_s) {{
    if (!s_ui_ready) return false;
    snprintf(s_last_title, sizeof(s_last_title), "%s", title ? title : "");
    snprintf(s_last_msg, sizeof(s_last_msg), "%s", message ? message : "");
    s_last_duration_s = duration_s;
    return true;
}}

static cJSON *wg1200_weather_sensors_command(void) {{
    cJSON *res = cJSON_CreateObject();
    cJSON *gw = cJSON_AddObjectToObject(res, "gateway_temperature");
    cJSON_AddNumberToObject(gw, "value", 32.4);
    cJSON_AddStringToObject(gw, "unit", "C");
    cJSON *baro = cJSON_AddObjectToObject(res, "barometric_pressure");
    cJSON_AddNumberToObject(baro, "value", 1004.5);
    cJSON_AddStringToObject(baro, "unit", "hPa");
    cJSON *outdoor = cJSON_AddObjectToObject(res, "outdoor_temperature");
    cJSON_AddNumberToObject(outdoor, "value", 19.2);
    cJSON_AddStringToObject(outdoor, "unit", "C");
    cJSON *gust = cJSON_AddObjectToObject(res, "wind_gust");
    cJSON_AddNumberToObject(gust, "value", 4.8);
    cJSON_AddStringToObject(gust, "unit", "m/s");
    cJSON *rate = cJSON_AddObjectToObject(res, "rain_rate");
    cJSON_AddNumberToObject(rate, "value", 0.0);
    cJSON_AddStringToObject(rate, "unit", "mm/h");
    cJSON *daily = cJSON_AddObjectToObject(res, "rain_daily");
    cJSON_AddNumberToObject(daily, "value", 1.2);
    cJSON_AddStringToObject(daily, "unit", "mm");
    return res;
}}

static cJSON *wg1200_boot_weatherxm_command(cJSON *params) {{
    const char *slot = "ota_0";
    cJSON *slot_item = params ? cJSON_GetObjectItem(params, "slot") : NULL;
    if (cJSON_IsString(slot_item) && slot_item->valuestring && slot_item->valuestring[0]) {{
        slot = slot_item->valuestring;
    }}
    cJSON *res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", true);
    cJSON_AddStringToObject(res, "boot_target", slot);
    return res;
}}

{string_param_fn}
{int_param_fn}
{row_params_fn}
{add_command_fn}
{add_meta_fn}
{build_register_fn}
{command_error_fn}
{wg1200_notify_fn}

static cJSON *dispatch_wg1200_command(const char *command, cJSON *params) {{
    {wg1200_branch}
    return command_error("unknown_command", command);
}}

int main(int argc, char **argv) {{
    if (argc < 2) return 2;
    if (strcmp(argv[1], "register") == 0) {{
        char *s = build_register_json();
        puts(s ? s : "{{}}");
        free(s);
        return 0;
    }}
    if (strcmp(argv[1], "invoke") == 0 && argc >= 4) {{
        if (argc >= 5 && strcmp(argv[4], "muted") == 0) {{
            s_speaker_on = false;
        }}
        cJSON *params = cJSON_Parse(argv[3]);
        cJSON *res = dispatch_wg1200_command(argv[2], params);
        cJSON_AddNumberToObject(res, "_beep_called", s_last_beep_ms);
        cJSON_AddStringToObject(res, "_ui_title", s_last_title);
        cJSON_AddStringToObject(res, "_ui_msg", s_last_msg);
        char *out = cJSON_PrintUnformatted(res);
        puts(out ? out : "{{}}");
        free(out);
        cJSON_Delete(res);
        cJSON_Delete(params);
        return 0;
    }}
    return 2;
}}
"""
        cls._tmpdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls._tmpdir.cleanup)
        out_dir = Path(cls._tmpdir.name)
        cls.bin_path = out_dir / "test_wg1200_harness"
        cjson_obj = out_dir / "cjson.o"
        src_path = out_dir / "harness.cpp"
        src_path.write_text(harness_cpp, encoding="utf-8")

        subprocess.run(
            [
                cc,
                "-std=c11",
                "-O2",
                f"-I{CJSON_DIR}",
                "-c",
                str(CJSON_DIR / "cJSON.c"),
                "-o",
                str(cjson_obj),
            ],
            check=True,
        )
        subprocess.run(
            [
                cxx,
                "-std=c++17",
                "-O2",
                f"-I{CJSON_DIR}",
                str(src_path),
                str(cjson_obj),
                "-o",
                str(cls.bin_path),
            ],
            check=True,
        )

    def run_harness(self, *args: str) -> dict:
        proc = subprocess.run(
            [str(self.bin_path), *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(proc.stdout.strip())

    def test_register_advertises_wg1200_and_display_commands(self) -> None:
        reg = self.run_harness("register")
        self.assertEqual(reg["method"], "link.register")
        commands = reg["params"]["commands_v2"]

        self.assertIn("sensors.read", commands)
        self.assertIn("BMP390", commands["sensors.read"]["description"])
        self.assertIn("WS1001/WS1300", commands["sensors.read"]["description"])
        self.assertIn("gateway_temperature", commands["sensors.read"]["description"])
        self.assertIn("barometric_pressure", commands["sensors.read"]["description"])
        self.assertIn("outdoor_temperature", commands["sensors.read"]["description"])
        self.assertIn("wind_gust", commands["sensors.read"]["description"])
        self.assertIn("rain_rate", commands["sensors.read"]["description"])
        self.assertIn("rain_daily", commands["sensors.read"]["description"])

        self.assertIn("device.boot_weatherxm", commands)
        self.assertIn("slot", commands["device.boot_weatherxm"]["optional"])
        self.assertEqual(
            commands["device.boot_weatherxm"]["optional"]["slot"]["type"], "string"
        )

        self.assertIn("wg1200.notify", commands)
        notify_cmd = commands["wg1200.notify"]
        self.assertIn("message", notify_cmd["required"])
        self.assertEqual(notify_cmd["required"]["message"]["type"], "string")
        self.assertIn("title", notify_cmd["optional"])
        self.assertEqual(notify_cmd["optional"]["title"]["type"], "string")
        self.assertIn("beep_ms", notify_cmd["optional"])
        self.assertEqual(notify_cmd["optional"]["beep_ms"]["type"], "integer")
        self.assertIn("duration_s", notify_cmd["optional"])
        self.assertEqual(notify_cmd["optional"]["duration_s"]["type"], "integer")

        self.assertIn("display.draw_url", commands)
        self.assertIn("480x480", commands["display.draw_url"]["description"])
        self.assertIn("display.draw_file", commands)
        self.assertIn("display.show_animation", commands)

    def test_dispatch_sensors_read(self) -> None:
        res = self.run_harness("invoke", "sensors.read", "{}")
        self.assertEqual(res["gateway_temperature"]["value"], 32.4)
        self.assertEqual(res["barometric_pressure"]["value"], 1004.5)
        self.assertEqual(res["outdoor_temperature"]["value"], 19.2)
        self.assertEqual(res["wind_gust"]["value"], 4.8)
        self.assertEqual(res["rain_rate"]["value"], 0.0)
        self.assertEqual(res["rain_daily"]["value"], 1.2)

    def test_dispatch_wg1200_notify_and_validation(self) -> None:
        err = self.run_harness("invoke", "wg1200.notify", "{}")
        self.assertEqual(err["error"]["code"], "missing_param")

        bad_beep = self.run_harness(
            "invoke", "wg1200.notify", json.dumps({"message": "Hi", "beep_ms": 2000})
        )
        self.assertEqual(bad_beep["error"]["code"], "invalid_params")

        ok = self.run_harness(
            "invoke",
            "wg1200.notify",
            json.dumps(
                {
                    "title": "Wind Alert",
                    "message": "Gusts reaching 14 m/s",
                    "beep_ms": 250,
                    "duration_s": 45,
                }
            ),
        )
        self.assertTrue(ok["ok"])
        self.assertEqual(ok["title"], "Wind Alert")
        self.assertEqual(ok["beep_ms"], 250)
        self.assertEqual(ok["duration_s"], 45)
        self.assertEqual(ok["_beep_called"], 250)
        self.assertEqual(ok["_ui_title"], "Wind Alert")
        self.assertEqual(ok["_ui_msg"], "Gusts reaching 14 m/s")

        muted = self.run_harness(
            "invoke",
            "wg1200.notify",
            json.dumps({"message": "Silent update", "beep_ms": 200}),
            "muted",
        )
        self.assertTrue(muted["ok"])
        self.assertTrue(muted["muted"])
        self.assertEqual(muted["beep_ms"], 0)
        self.assertEqual(muted["_beep_called"], 0)

    def test_dispatch_boot_weatherxm(self) -> None:
        res = self.run_harness(
            "invoke", "device.boot_weatherxm", json.dumps({"slot": "factory"})
        )
        self.assertTrue(res["ok"])
        self.assertEqual(res["boot_target"], "factory")


if __name__ == "__main__":
    unittest.main()
