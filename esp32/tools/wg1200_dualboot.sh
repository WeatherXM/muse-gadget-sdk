#!/bin/bash
# Non-destructive WeatherXM WG1200 Dual-Boot Tool for Muse Gadget
#
# Preserves:
#   - Bootloader      (0x000000, 48 KB)
#   - esp_secure_cert (0x00D000, 8 KB)   - ATECC608B/X.509 identity
#   - nvs             (0x00F000, 16 KB)  - WeatherXM credentials/Wi-Fi/station settings
#   - phy_init        (0x015000, 4 KB)
#   - factory         (0x020000, 4 MB)   - WeatherXM factory firmware
#   - ota_0           (0x420000, 4 MB)   - WeatherXM active OTA firmware
#   - nvs_key         (0xC20000, 4 KB)   - WeatherXM NVS encryption key
#   - spiffs          (0xC21000, 3 MB)   - WeatherXM UI/storage
#
# Updates only:
#   - partition-table (0x00C000, 4 KB)   - Adds muse_nvs at 0xF21000
#   - ota_1           (0x820000, 4 MB)   - Signed Muse Gadget firmware
#   - otadata         (0x013000, 8 KB)   - Boot selector (ota_1 <-> ota_0)

set -euo pipefail

CMD=${1:-help}
PORT=${2:-/dev/cu.usbserial-1110}
BAUD=${BAUD:-460800}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD_DIR="$ROOT/build-muse-wxm-wg1200"
BACKUP_DIR="$ROOT/../backups/wg1200_stock_backup"
SIGNING_KEY=${WXM_SIGNING_KEY:-$ROOT/secure_boot_signing_key.pem}

activate_idf() {
    if ! command -v idf.py >/dev/null 2>&1; then
        for d in "$HOME/.platformio/packages/framework-espidf" "$HOME/.espressif/esp-idf-v5.5" "$HOME/esp/esp-idf"; do
            if [ -f "$d/export.sh" ]; then
                # shellcheck disable=SC1090
                . "$d/export.sh" >/dev/null 2>&1
                break
            fi
        done
    fi
    command -v idf.py >/dev/null 2>&1 || { echo "Error: idf.py not found in PATH" >&2; exit 1; }
}

make_otadata_slot() {
    local slot=$1
    local out=$2
    python3 - "$slot" "$out" << 'PY'
import sys, struct, binascii

slot = int(sys.argv[1])  # 0 for ota_0, 1 for ota_1
out_path = sys.argv[2]

def make_entry(seq):
    seq_bytes = struct.pack("<I", seq)
    crc = binascii.crc32(seq_bytes, 0xFFFFFFFF) & 0xFFFFFFFF
    # state = 0x00000002 (ESP_OTA_IMG_VALID)
    entry = struct.pack("<I20sII", seq, b"\xff" * 20, 0x00000002, crc)
    return entry + b"\xff" * (4096 - len(entry))

# In ESP-IDF: (ota_seq - 1) % num_ota_partitions == slot
#   seq=1 -> ota_0, seq=2 -> ota_1, seq=3 -> ota_0
#   slot=-1 -> all 0xFF (boots factory at 0x20000)
if slot < 0:
    data = b"\xff" * 8192
elif slot == 0:
    data = make_entry(3) + make_entry(2)
else:
    data = make_entry(1) + make_entry(2)

with open(out_path, "wb") as f:
    f.write(data)
PY
}

case "$CMD" in
    backup)
        activate_idf
        mkdir -p "$BACKUP_DIR"
        echo "Backing up critical WG1200 partitions from $PORT to $BACKUP_DIR..."
        python3 -m esptool --chip esp32s3 -p "$PORT" -b "$BAUD" --no-stub read_flash \
            0x000000 0x16000 "$BACKUP_DIR/low_flash_0x0_to_0x16000.bin" \
            0x00C000 0x01000 "$BACKUP_DIR/partition-table.bin" \
            0x00D000 0x02000 "$BACKUP_DIR/esp_secure_cert.bin" \
            0x00F000 0x04000 "$BACKUP_DIR/nvs.bin" \
            0x013000 0x02000 "$BACKUP_DIR/otadata.bin" \
            0x015000 0x01000 "$BACKUP_DIR/phy_init.bin" \
            0xC20000 0x01000 "$BACKUP_DIR/nvs_key.bin"
        echo "Backup complete in $BACKUP_DIR"
        ;;

    build)
        activate_idf
        cd "$ROOT"
        idf.py -B "$BUILD_DIR" -DIDF_TARGET=esp32s3 \
            -DSDKCONFIG="$BUILD_DIR/sdkconfig" \
            -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;devices/sdkconfig.wxm-wg1200" \
            build
        if [ -f "$SIGNING_KEY" ]; then
            echo "Verifying Secure Boot V2 RSA-3072 signature on $BUILD_DIR/muse-gadget.bin..."
            espsecure.py verify_signature --version 2 --keyfile "$SIGNING_KEY" "$BUILD_DIR/muse-gadget.bin"
        fi
        ;;

    install)
        activate_idf
        if [ ! -f "$BUILD_DIR/muse-gadget.bin" ]; then
            echo "Error: $BUILD_DIR/muse-gadget.bin not found. Run '$0 build' first." >&2
            exit 1
        fi
        if [ -f "$SIGNING_KEY" ]; then
            espsecure.py verify_signature --version 2 --keyfile "$SIGNING_KEY" "$BUILD_DIR/muse-gadget.bin"
        fi
        OTADATA_OTA1="$BUILD_DIR/otadata_ota1.bin"
        make_otadata_slot 1 "$OTADATA_OTA1"
        echo "Flashing dual-boot partition table (0xC000), Muse Gadget -> ota_1 (0x820000), and otadata -> ota_1 (0x13000)..."
        python3 -m esptool --chip esp32s3 -p "$PORT" -b "$BAUD" --no-stub \
            --before default_reset --after hard_reset write_flash \
            0x00C000 "$BUILD_DIR/partition_table/partition-table.bin" \
            0x013000 "$OTADATA_OTA1" \
            0x820000 "$BUILD_DIR/muse-gadget.bin"
        echo "Muse Gadget installed in ota_1 (0x820000). WeatherXM remains untouched in factory/ota_0!"
        ;;

    boot-weatherxm)
        activate_idf
        mkdir -p "$BUILD_DIR"
        HDR_OTA0="$BUILD_DIR/ota0_hdr.bin"
        python3 -m esptool --chip esp32s3 -p "$PORT" -b "$BAUD" --no-stub \
            read_flash 0x420000 0x120 "$HDR_OTA0" >/dev/null 2>&1 || true
        SLOT=$(python3 - "$HDR_OTA0" << 'PY'
import sys
try:
    b = open(sys.argv[1], "rb").read()
    # esp_app_desc_t starts at offset 0x20; project_name is at offset 0x20 + 0x30 = 0x50 (32 bytes)
    proj = b[0x50:0x70].split(b"\x00", 1)[0].decode("ascii", "ignore").lower()
    if proj.startswith(("wg1", "weatherxm", "wxm")):
        print("0")
    else:
        print("-1")
except Exception:
    print("-1")
PY
)
        OTADATA_WXM="$BUILD_DIR/otadata_wxm.bin"
        make_otadata_slot "$SLOT" "$OTADATA_WXM"
        if [ "$SLOT" = "0" ]; then
            echo "Switching WG1200 boot selector to WeatherXM in ota_0 (0x420000)..."
        else
            echo "Switching WG1200 boot selector to WeatherXM in factory (0x20000)..."
        fi
        python3 -m esptool --chip esp32s3 -p "$PORT" -b "$BAUD" --no-stub \
            --before default_reset --after hard_reset write_flash \
            0x013000 "$OTADATA_WXM"
        echo "WG1200 is now booting into WeatherXM firmware."
        ;;

    boot-factory)
        activate_idf
        mkdir -p "$BUILD_DIR"
        OTADATA_FACTORY="$BUILD_DIR/otadata_factory.bin"
        make_otadata_slot -1 "$OTADATA_FACTORY"
        echo "Switching WG1200 boot selector to factory (0x20000)..."
        python3 -m esptool --chip esp32s3 -p "$PORT" -b "$BAUD" --no-stub \
            --before default_reset --after hard_reset write_flash \
            0x013000 "$OTADATA_FACTORY"
        echo "WG1200 is now booting into factory partition."
        ;;

    boot-ota0)
        activate_idf
        mkdir -p "$BUILD_DIR"
        OTADATA_OTA0="$BUILD_DIR/otadata_ota0.bin"
        make_otadata_slot 0 "$OTADATA_OTA0"
        echo "Switching WG1200 boot selector to ota_0 (0x420000)..."
        python3 -m esptool --chip esp32s3 -p "$PORT" -b "$BAUD" --no-stub \
            --before default_reset --after hard_reset write_flash \
            0x013000 "$OTADATA_OTA0"
        echo "WG1200 is now booting into ota_0 partition."
        ;;

    boot-muse)
        activate_idf
        mkdir -p "$BUILD_DIR"
        OTADATA_OTA1="$BUILD_DIR/otadata_ota1.bin"
        make_otadata_slot 1 "$OTADATA_OTA1"
        echo "Switching WG1200 boot selector to Muse Gadget (ota_1)..."
        python3 -m esptool --chip esp32s3 -p "$PORT" -b "$BAUD" --no-stub \
            --before default_reset --after hard_reset write_flash \
            0x013000 "$OTADATA_OTA1"
        echo "WG1200 is now booting into Muse Gadget."
        ;;

    *)
        echo "Usage: $0 {backup|build|install|boot-weatherxm|boot-factory|boot-ota0|boot-muse} [serial-port]"
        exit 1
        ;;
esac
