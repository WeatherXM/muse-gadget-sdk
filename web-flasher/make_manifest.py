#!/usr/bin/env python3
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

"""Copy one board's flash images out of an ESP-IDF build directory and write
an ESP Web Tools manifest for them.

Usage: make_manifest.py BUILD_DIR OUT_DIR NAME VERSION

The images are flashed one by one at their own offsets, exactly like
`idf.py flash`, rather than as a single merged image: a merged image would
pad the gap where NVS lives with 0xFF and wipe the device's pairing and Wi-Fi
settings on every update.
"""

import binascii
import json
import shutil
import struct
import sys
from pathlib import Path

# ESP-IDF target -> ESP Web Tools chipFamily.
CHIP_FAMILIES = {
    "esp32": "ESP32",
    "esp32s2": "ESP32-S2",
    "esp32s3": "ESP32-S3",
    "esp32c2": "ESP32-C2",
    "esp32c3": "ESP32-C3",
    "esp32c5": "ESP32-C5",
    "esp32c6": "ESP32-C6",
    "esp32h2": "ESP32-H2",
    "esp32p4": "ESP32-P4",
}


def partitions_end(table):
    """Where the last partition in a binary partition table ends: the flash
    the build needs."""
    end = 0
    for i in range(0, len(table) - 31, 32):
        magic, _type, _subtype, offset, size = struct.unpack_from("<HBBII", table, i)
        if magic != 0x50AA:   # 0xEBEB is the table's MD5, 0xFFFF the end
            break
        end = max(end, offset + size)
    return end


def make_otadata_ota1() -> bytes:
    """Construct an 8 KB otadata image that selects ota_1 (seq=2, VALID)."""
    def make_entry(seq: int) -> bytes:
        seq_bytes = struct.pack("<I", seq)
        crc = binascii.crc32(seq_bytes, 0xFFFFFFFF) & 0xFFFFFFFF
        entry = struct.pack("<I20sII", seq, b"\xff" * 20, 0x00000002, crc)
        return entry + b"\xff" * (4096 - len(entry))

    return make_entry(1) + make_entry(2)


def is_wg1200_dualboot(build: Path, out: Path) -> bool:
    if out.name == "wxm-wg1200":
        return True
    sdkconfig = build / "sdkconfig"
    if sdkconfig.exists():
        text = sdkconfig.read_text(errors="ignore")
        if 'CONFIG_PARTITION_TABLE_FILENAME="partitions_wg1200_dualboot.csv"' in text:
            return True
    return False


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    build, out, name, version = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]

    args = json.loads((build / "flasher_args.json").read_text())
    chip = args["extra_esptool_args"]["chip"]

    out.mkdir(parents=True, exist_ok=True)
    table = (build / args["partition-table"]["file"]).read_bytes()

    if is_wg1200_dualboot(build, out):
        # Safe non-destructive dual-boot layout for WeatherXM WG1200:
        # Never touch bootloader (0x0), esp_secure_cert (0xD000), nvs (0xF000),
        # factory (0x20000), ota_0 (0x420000), nvs_key (0xC20000), or spiffs (0xC21000).
        pt_src = build / args["partition-table"]["file"]
        app_src = build / args["app"]["file"]
        shutil.copyfile(pt_src, out / "partition-table.bin")
        (out / "otadata_ota1.bin").write_bytes(make_otadata_ota1())
        shutil.copyfile(app_src, out / "muse-gadget.bin")
        parts = [
            {"path": "partition-table.bin", "offset": 0xC000},
            {"path": "otadata_ota1.bin", "offset": 0x13000},
            {"path": "muse-gadget.bin", "offset": 0x820000},
        ]
        prompt_erase = False
    else:
        parts = []
        for offset, file in sorted(args["flash_files"].items(), key=lambda kv: int(kv[0], 16)):
            dest = Path(file).name
            shutil.copyfile(build / file, out / dest)
            parts.append({"path": dest, "offset": int(offset, 16)})
        prompt_erase = True

    manifest = {
        "name": name,
        "version": version,
        # Offer to erase on first install (except dual-boot boards where erase is forbidden);
        # updates keep pairing and Wi-Fi.
        "new_install_prompt_erase": prompt_erase,
        # Not ESP Web Tools': the page refuses boards with less flash.
        "min_flash_bytes": partitions_end(table),
        "builds": [{"chipFamily": CHIP_FAMILIES[chip], "parts": parts}],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
