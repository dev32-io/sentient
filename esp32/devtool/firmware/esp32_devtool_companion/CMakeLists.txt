set(DEVTOOL_REQ esp_http_server esp_netif esp_event json lvgl__lvgl)

if(CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE)
    set(DEVTOOL_SRCS
        src/companion.cc
        src/usb_cdc_reader.cc
        src/verb_dispatcher.cc
        src/http_server.cc
        src/log_relay.cc
        src/handlers/info.cc
    )
    if(CONFIG_ESP32_DEVTOOL_SCREENSHOT_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/screenshot.cc)
    endif()
    if(CONFIG_ESP32_DEVTOOL_TOUCH_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/touch.cc)
    endif()
    if(CONFIG_ESP32_DEVTOOL_AUDIO_RECORD_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/audio_record.cc)
    endif()
    if(CONFIG_ESP32_DEVTOOL_AUDIO_INJECT_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/audio_inject.cc)
    endif()
else()
    set(DEVTOOL_SRCS src/companion_stub.cc)
endif()

idf_component_register(
    SRCS ${DEVTOOL_SRCS}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    REQUIRES ${DEVTOOL_REQ}
    PRIV_REQUIRES esp_wifi
    WHOLE_ARCHIVE
)
