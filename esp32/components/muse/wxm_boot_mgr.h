/*
 * WeatherXM WG1200 Boot Guard, NVS Isolation & Dual-Boot Partition Switcher
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "esp_partition.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const esp_partition_t *wxm_part;
    char wxm_label[16];
    char wxm_project[32];
    char wxm_version[32];

    const esp_partition_t *alt_part;
    char alt_label[16];
    char alt_project[32];
    char alt_version[32];
} wxm_boot_info_t;

/*
 * Releases GPIO10 hold from previous reset and registers the shutdown handler
 * that forces GPIO10 HIGH + pad-held across soft resets so legacy v0.1.9
 * bootloaders never mistake a soft reset for a GPIO38+GPIO10 factory reset.
 */
void wxm_boot_guard_init(void);

/*
 * Forces GPIO10 (LCD_DATA_G0) HIGH and enables RTC pad hold before esp_restart().
 */
void wxm_prepare_safe_restart_gpios(void);

/*
 * Populates info about the preserved WeatherXM partition (factory or ota_0)
 * and any secondary non-Muse partition.
 */
void wxm_boot_get_info(wxm_boot_info_t *out);

/*
 * Switches active boot partition back to WeatherXM (or specified partition)
 * and reboots safely with GPIO10 held HIGH.
 */
esp_err_t wxm_boot_return_to_weatherxm(void);
esp_err_t wxm_boot_to_partition(const esp_partition_t *part);

#ifdef __cplusplus
}
#endif
