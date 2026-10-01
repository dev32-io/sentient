# Define source files
# v2 rescope: removed orphan SRCS — mcp_server.cc + ota.cc +
# protocols/mqtt_protocol.cc (stripped).
set(SOURCES "audio/audio_codec.cc"
            "audio/audio_service.cc"
            "audio/audio_inject_ring.cc"
            "audio/demuxer/ogg_demuxer.cc"
            "audio/codecs/no_audio_codec.cc"
            "audio/codecs/box_audio_codec.cc"
            "audio/codecs/es8311_audio_codec.cc"
            "audio/codecs/es8374_audio_codec.cc"
            "audio/codecs/es8388_audio_codec.cc"
            "audio/codecs/es8389_audio_codec.cc"
            "audio/codecs/dummy_audio_codec.cc"
            "audio/processors/audio_debugger.cc"
            "led/single_led.cc"
            "led/circular_strip.cc"
            "led/gpio_led.cc"
            "display/display.cc"
            "display/lcd_display.cc"
            "display/oled_display.cc"
            "display/lvgl_display/lvgl_display.cc"
            "display/emote_display.cc"
            "display/lvgl_display/emoji_collection.cc"
            "display/lvgl_display/lvgl_theme.cc"
            "display/lvgl_display/lvgl_font.cc"
            "display/lvgl_display/lvgl_image.cc"
            "display/lvgl_display/gif/lvgl_gif.cc"
            "display/lvgl_display/gif/gifdec.c"
            "display/lvgl_display/jpg/image_to_jpeg.cpp"
            "display/lvgl_display/jpg/jpeg_to_image.c"
            "protocols/sentient_ws_protocol.cc"
            "system_info.cc"
            "application.cc"
            "settings.cc"
            "device_state_machine.cc"
            "assets.cc"
            "main.cc"
            "../ui-shared/test_screen.c"
            )

# devtool_verbs — migrated verb implementations for the esp32-devtool dispatcher.
# Task 14: state, button.toggle, sentient.status, mark.
# Task 24: remaining verbs (wifi.*, tts.cancel, audio.dump_state/play_pcm/test_tone/
#          record_rms/record_pcm, log_level, restart, sentient.force_reconnect,
#          sentient.last_transcript, ui.dump_tree).
# Task 27: deleted the agent_console component entirely. audio.inject_pcm
#          was the last verb in components/agent_console/; it did NOT migrate
#          — the canonical inject path is the HTTP POST /audio/inject endpoint
#          (esp32_devtool_companion/src/handlers/audio_inject.cc), which calls
#          audio_inject_ring_push() directly via the cube_audio_inject_provider
#          registered in sentient_cube.cc.
# WHOLE_ARCHIVE (set on idf_component_register below) is required: the linker
# would strip these __attribute__((constructor)) registrations from the static
# library without it. audio_common.cc carries no constructors; listed here for
# completeness since audio_play.cc + audio_record_usb.cc include its header.
list(APPEND SOURCES
    "devtool_verbs/state.cc"
    "devtool_verbs/button.cc"
    "devtool_verbs/sentient.cc"
    "devtool_verbs/mark.cc"
    "devtool_verbs/wifi.cc"
    "devtool_verbs/tts.cc"
    "devtool_verbs/audio_misc.cc"
    "devtool_verbs/audio_play.cc"
    "devtool_verbs/audio_record_usb.cc"
    "devtool_verbs/audio_common.cc"
    "devtool_verbs/log_level.cc"
    "devtool_verbs/restart.cc"
    "devtool_verbs/sentient_misc.cc"
    "devtool_verbs/ui.cc"
)

set(INCLUDE_DIRS "." "display" "display/lvgl_display" "display/lvgl_display/jpg" "audio" "audio/demuxer" "protocols" "../ui-shared")

# Add board common files
# v2 rescope: dropped boards/common/press_to_talk_mcp_tool.cc — references
# McpServer which was stripped from the build. Re-add if a future feature
# needs press-to-talk-as-MCP-tool; current PTT path goes through the
# Application::ToggleChatState() event flow directly.
list(APPEND SOURCES
    "boards/common/board.cc"
    "boards/common/wifi_board.cc"
    "boards/common/ml307_board.cc"
    "boards/common/nt26_board.cc"
    "boards/common/dual_network_board.cc"
    "boards/common/adc_battery_monitor.cc"
    "boards/common/afsk_demod.cc"
    "boards/common/axp2101.cc"
    "boards/common/backlight.cc"
    "boards/common/button.cc"
    "boards/common/i2c_device.cc"
    "boards/common/knob.cc"
    "boards/common/power_save_timer.cc"
    "boards/common/sleep_timer.cc"
    "boards/common/sy6970.cc"
    "boards/common/system_reset.cc"
)
list(APPEND INCLUDE_DIRS ${CMAKE_CURRENT_SOURCE_DIR}/boards/common)


idf_build_get_property(build_components BUILD_COMPONENTS)
# Function to find component dynamically by pattern
function(find_component_by_pattern PATTERN COMPONENT_VAR PATH_VAR)
    foreach(COMPONENT ${build_components})
        if(COMPONENT MATCHES "${PATTERN}")
            set(${COMPONENT_VAR} ${COMPONENT} PARENT_SCOPE)
            idf_component_get_property(COMPONENT_PATH ${COMPONENT} COMPONENT_DIR)
            set(${PATH_VAR} "${COMPONENT_PATH}" PARENT_SCOPE)
            break()
        endif()
    endforeach()
endfunction()

# Set default BUILTIN_TEXT_FONT and BUILTIN_ICON_FONT
set(BUILTIN_TEXT_FONT font_puhui_14_1)
set(BUILTIN_ICON_FONT font_awesome_14_1)

set(EMOTE_RESOLUTION "320_240")

# Add board files according to BOARD_TYPE
# Set default assets if the board uses partition table V2
if(CONFIG_BOARD_TYPE_SENTIENT_CUBE)
    # v2 rescope: Sentient Cube — based on Waveshare ESP32-S3-Touch-AMOLED-2.16.
    # MANUFACTURER intentionally unset so the board GLOB falls into the
    # flat boards/${BOARD_TYPE}/ branch and matches main/boards/sentient-cube/.
    set(BOARD_TYPE "sentient-cube")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_BREAD_COMPACT_WIFI)
    set(BOARD_TYPE "bread-compact-wifi")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_BREAD_COMPACT_ML307)
    set(BOARD_TYPE "bread-compact-ml307")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_BREAD_COMPACT_NT26)
    set(BOARD_TYPE "bread-compact-nt26")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_BREAD_COMPACT_ESP32)
    set(BOARD_TYPE "bread-compact-esp32")
elseif(CONFIG_BOARD_TYPE_BREAD_COMPACT_ESP32_LCD)
    set(BOARD_TYPE "bread-compact-esp32-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_DF_K10)
    set(BOARD_TYPE "df-k10")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_DF_S3_AI_CAM)
    set(BOARD_TYPE "df-s3-ai-cam")
elseif(CONFIG_BOARD_TYPE_ESP_BOX_3)
    set(BOARD_TYPE "esp-box-3")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
    set(EMOTE_RESOLUTION "320_240")
elseif(CONFIG_BOARD_TYPE_ESP_BOX)
    set(BOARD_TYPE "esp-box")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
    set(EMOTE_RESOLUTION "320_240")
elseif(CONFIG_BOARD_TYPE_ESP_BOX_LITE)
    set(BOARD_TYPE "esp-box-lite")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_KEVIN_BOX_2)
    set(BOARD_TYPE "kevin-box-2")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_KEVIN_C3)
    set(BOARD_TYPE "kevin-c3")
elseif(CONFIG_BOARD_TYPE_KEVIN_SP_V3_DEV)
    set(BOARD_TYPE "kevin-sp-v3-dev")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_KEVIN_SP_V4_DEV)
    set(BOARD_TYPE "kevin-sp-v4-dev")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_KEVIN_YUYING_313LCD)
    set(BOARD_TYPE "kevin-yuying-313lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_LICHUANG_DEV_S3)
    set(BOARD_TYPE "lichuang-dev")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_LICHUANG_DEV_C3)
    set(BOARD_TYPE "lichuang-c3-dev")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_EDA_TV_PRO)
    set(MANUFACTURER "lceda-course-examples")
    set(BOARD_TYPE "eda-tv-pro")
elseif(CONFIG_BOARD_TYPE_EDA_ROBOT_PRO)
    set(MANUFACTURER "lceda-course-examples")
    set(BOARD_TYPE "eda-robot-pro")
    set(BUILTIN_TEXT_FONT font_puhui_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
elseif(CONFIG_BOARD_TYPE_EDA_SUPER_BEAR)
    set(MANUFACTURER "lceda-course-examples")
    set(BOARD_TYPE "eda-super-bear")
elseif(CONFIG_BOARD_TYPE_MAGICLICK_S3_2P4)
    set(BOARD_TYPE "magiclick-2p4")
    set(BUILTIN_TEXT_FONT font_noto_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_64)
elseif(CONFIG_BOARD_TYPE_MAGICLICK_S3_2P5)
    set(BOARD_TYPE "magiclick-2p5")
    set(BUILTIN_TEXT_FONT font_noto_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_64)
elseif(CONFIG_BOARD_TYPE_MAGICLICK_C3)
    set(BOARD_TYPE "magiclick-c3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_MAGICLICK_C3_V2)
    set(BOARD_TYPE "magiclick-c3-v2")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_M5STACK_CORE_S3)
    set(BOARD_TYPE "m5stack-core-s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_M5STACK_CORE_TAB5)
    set(BOARD_TYPE "m5stack-tab5")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_M5STACK_ATOM_S3_ECHO_BASE)
    set(BOARD_TYPE "atoms3-echo-base")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_M5STACK_ATOM_S3R_ECHO_BASE)
    set(BOARD_TYPE "atoms3r-echo-base")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_M5STACK_ATOM_S3R_CAM_M12_ECHO_BASE)
    set(BOARD_TYPE "atoms3r-cam-m12-echo-base")
elseif(CONFIG_BOARD_TYPE_M5STACK_ATOM_ECHOS3R)
    set(BOARD_TYPE "atom-echos3r")
elseif(CONFIG_BOARD_TYPE_M5STACK_CARDPUTER_ADV)
    set(BOARD_TYPE "m5stack-cardputer-adv")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_M5STACK_ATOM_MATRIX_ECHO_BASE)
    set(BOARD_TYPE "atommatrix-echo-base")
elseif(CONFIG_BOARD_TYPE_XMINI_C3_V3)
    set(BOARD_TYPE "xmini-c3-v3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_XMINI_C3_4G)
    set(BOARD_TYPE "xmini-c3-4g")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_XMINI_C3)
    set(BOARD_TYPE "xmini-c3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_ESP_KORVO2_V3)
    set(BOARD_TYPE "esp32s3-korvo2-v3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ESP_KORVO2_V3_RNDIS)
    set(BOARD_TYPE "esp32s3-korvo2-v3-rndis")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ESP_SPARKBOT)
    set(BOARD_TYPE "esp-sparkbot")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ESP_SPOT_S3)
    set(BOARD_TYPE "esp-spot")
elseif(CONFIG_BOARD_TYPE_ESP_SPOT_C5)
    set(BOARD_TYPE "esp-spot")
elseif(CONFIG_BOARD_TYPE_ESP_HI)
    set(BOARD_TYPE "esp-hi")
    # Set ESP_HI emoji directory for DEFAULT_ASSETS_EXTRA_FILES
    set(DEFAULT_ASSETS_EXTRA_FILES "${CMAKE_BINARY_DIR}/emoji")
elseif(CONFIG_BOARD_TYPE_ESP_VOCAT)
    set(BOARD_TYPE "esp-vocat")
    set(BUILTIN_TEXT_FONT font_puhui_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
    set(EMOTE_RESOLUTION "360_360")
    # set(EMOTE_EXTERNAL_PATH "${CMAKE_CURRENT_SOURCE_DIR}/boards/esp-vocat/assets")
elseif(CONFIG_BOARD_TYPE_ESP_SENSAIRSHUTTLE)
    set(BOARD_TYPE "esp-sensairshuttle")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_TOUCH_LCD_3_5)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-touch-lcd-3.5")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_CAM_XXXX)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-cam")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_AUDIO_BOARD)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-audio-board")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_1_8)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-amoled-1.8")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_C6_TOUCH_AMOLED_1_8)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-c6-touch-amoled-1.8")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_2_06)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-amoled-2.06")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_C6_TOUCH_AMOLED_2_06)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-c6-touch-amoled-2.06")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_C6_TOUCH_AMOLED_2_16)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-c6-touch-amoled-2.16")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_2_16)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-amoled-2.16")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_1_43C)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-amoled-1.43c")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_4B)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-4b")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_4_3C)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-4.3c")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_1_75)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-amoled-1.75")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_1_75C)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-amoled-1.75")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_83)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-1.83")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_85C)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-1.85c")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_85)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-1.85")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_46)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-1.46")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_3_5)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-3.5")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_3_5B)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-3.5b")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_ePaper_1_54_v1)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-epaper-1.54")
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_ePaper_1_54_v2)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-epaper-1.54")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_ePaper_3_97)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-epaper-3.97")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_RLCD_4_2)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-rlcd-4.2")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_3_49)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-3.49")
    set(LVGL_TEXT_FONT font_puhui_basic_30_4)
    set(LVGL_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_54)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-lcd-1.54")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_LCD_0_85)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-lcd-0.85")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_C6_LCD_1_69)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-c6-lcd-1.69")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_C6_TOUCH_LCD_1_83)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-c6-touch-lcd-1.83")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_C6_TOUCH_AMOLED_1_43)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-c6-touch-amoled-1.43")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_C6_TOUCH_AMOLED_1_32)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-c6-touch-amoled-1.32")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_1_32)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-s3-touch-amoled-1.32")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_NANO)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-nano")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_4B)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_4_3)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_7B)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_3_4C)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_3_5)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd-3.5")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_4C)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_7)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_8)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WAVESHARE_ESP32_P4_WIFI6_TOUCH_LCD_10_1)
    set(MANUFACTURER "waveshare")
    set(BOARD_TYPE "esp32-p4-wifi6-touch-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ESP_P4_FUNCTION_EV_BOARD)
    set(BOARD_TYPE "esp-p4-function-ev-board")
elseif(CONFIG_BOARD_TYPE_BREAD_COMPACT_WIFI_LCD)
    set(BOARD_TYPE "bread-compact-wifi-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_TUDOUZI)
    set(BOARD_TYPE "tudouzi")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_LILYGO_T_CIRCLE_S3)
    set(BOARD_TYPE "lilygo-t-circle-s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_LILYGO_T_CAMERAPLUS_S3_V1_0_V1_1)
    set(BOARD_TYPE "lilygo-t-cameraplus-s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_LILYGO_T_CAMERAPLUS_S3_V1_2)
    set(BOARD_TYPE "lilygo-t-cameraplus-s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_LILYGO_T_DISPLAY_S3_PRO_MVSRLORA)
    set(BOARD_TYPE "lilygo-t-display-s3-pro-mvsrlora")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_LILYGO_T_DISPLAY_S3_PRO_MVSRLORA_NO_BATTERY)
    set(BOARD_TYPE "lilygo-t-display-s3-pro-mvsrlora")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_LILYGO_T_DISPLAY_P4)
    set(BOARD_TYPE "lilygo-t-display-p4")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_MOVECALL_MOJI_ESP32S3)
    set(BOARD_TYPE "movecall-moji-esp32s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_MOVECALL_MOJI2_ESP32C5)
    set(BOARD_TYPE "movecall-moji2-esp32c5")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_MOVECALL_CUICAN_ESP32S3)
    set(BOARD_TYPE "movecall-cuican-esp32s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3)
    set(BOARD_TYPE "atk-dnesp32s3")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3_BOX)
    set(BOARD_TYPE "atk-dnesp32s3-box")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3_BOX0)
    set(BOARD_TYPE "atk-dnesp32s3-box0")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3_BOX2_WIFI)
    set(BOARD_TYPE "atk-dnesp32s3-box2-wifi")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3_BOX2_4G)
    set(BOARD_TYPE "atk-dnesp32s3-box2-4g")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3M_WIFI)
    set(BOARD_TYPE "atk-dnesp32s3m-wifi")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3M_4G)
    set(BOARD_TYPE "atk-dnesp32s3m-4g")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_ATK_DNESP32S3_BOX3)
    set(BOARD_TYPE "atk-dnesp32s3-box3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_DU_CHATX)
    set(BOARD_TYPE "du-chatx")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_TAIJI_PI_S3)
    set(BOARD_TYPE "taiji-pi-s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_XINGZHI_CUBE_0_85TFT_WIFI)
    set(BOARD_TYPE "xingzhi-cube-0.85tft-wifi")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_XINGZHI_CUBE_0_85TFT_ML307)
    set(BOARD_TYPE "xingzhi-cube-0.85tft-ml307")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_XINGZHI_CUBE_0_96OLED_WIFI)
    set(BOARD_TYPE "xingzhi-cube-0.96oled-wifi")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_XINGZHI_CUBE_0_96OLED_ML307)
    set(BOARD_TYPE "xingzhi-cube-0.96oled-ml307")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_XINGZHI_CUBE_1_54TFT_WIFI)
    set(BOARD_TYPE "xingzhi-cube-1.54tft-wifi")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_XINGZHI_CUBE_1_54TFT_ML307)
    set(BOARD_TYPE "xingzhi-cube-1.54tft-ml307")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_XINGZHI_METAL_1_54_WIFI)
    set(BOARD_TYPE "xingzhi-metal-1.54-wifi")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_XINGZHI_ABS_2_0)
    set(BOARD_TYPE "xingzhi-abs-2.0")
    set(BUILTIN_TEXT_FONT font_noto_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_SEEED_STUDIO_SENSECAP_WATCHER)
    set(BOARD_TYPE "sensecap-watcher")
    set(BUILTIN_TEXT_FONT font_noto_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION noto-emoji_128)
elseif(CONFIG_BOARD_TYPE_DOIT_S3_AIBOX)
    set(BOARD_TYPE "doit-s3-aibox")
elseif(CONFIG_BOARD_TYPE_MIXGO_NOVA)
    set(BOARD_TYPE "mixgo-nova")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_GENJUTECH_S3_1_54TFT)
    set(BOARD_TYPE "genjutech-s3-1.54tft")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_CGC)
    set(BOARD_TYPE "esp32-cgc")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_CGC_144)
    set(BOARD_TYPE "esp32-cgc-144")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_ESP_S3_LCD_EV_Board)
    set(BOARD_TYPE "esp-s3-lcd-ev-board")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ESP_S3_LCD_EV_Board_2)
    set(BOARD_TYPE "esp-s3-lcd-ev-board-2")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ZHENGCHEN_1_54TFT_WIFI)
    set(BOARD_TYPE "zhengchen-1.54tft-wifi")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_MINSI_K08_DUAL)
    set(BOARD_TYPE "minsi-k08-dual")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ZHENGCHEN_1_54TFT_ML307)
    set(BOARD_TYPE "zhengchen-1.54tft-ml307")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ZHENGCHEN_CAM)
    set(BOARD_TYPE "zhengchen-cam")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_ZHENGCHEN_CAM_ML307)
    set(BOARD_TYPE "zhengchen-cam-ml307")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_SPOTPEAR_ESP32_S3_1_54_MUMA)
    set(BOARD_TYPE "sp-esp32-s3-1.54-muma")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_SPOTPEAR_ESP32_S3_1_28_BOX)
    set(BOARD_TYPE "sp-esp32-s3-1.28-box")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_OTTO_ROBOT)
    set(BOARD_TYPE "otto-robot")
    set(BUILTIN_TEXT_FONT font_puhui_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION otto-gif)
elseif(CONFIG_BOARD_TYPE_ELECTRON_BOT)
    set(BOARD_TYPE "electron-bot")
    set(BUILTIN_TEXT_FONT font_puhui_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION otto-gif)
elseif(CONFIG_BOARD_TYPE_BREAD_COMPACT_WIFI_CAM)
    set(BOARD_TYPE "bread-compact-wifi-s3cam")
    set(BUILTIN_TEXT_FONT font_puhui_basic_16_4)
    set(BUILTIN_ICON_FONT font_awesome_16_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_JIUCHUAN)
    set(BOARD_TYPE "jiuchuan-s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_LABPLUS_MPYTHON_V3)
    set(BOARD_TYPE "labplus-mpython-v3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_LABPLUS_LEDONG_V2)
    set(BOARD_TYPE "labplus-ledong-v2")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_SURFER_C3_1_14TFT)
    set(BOARD_TYPE "surfer-c3-1.14tft")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_YUNLIAO_S3)
    set(BOARD_TYPE "yunliao-s3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_WIRELESS_TAG_WTP4C5MP07S)
    set(BOARD_TYPE "wireless-tag-wtp4c5mp07s")
    set(BUILTIN_TEXT_FONT font_puhui_basic_30_4)
    set(BUILTIN_ICON_FONT font_awesome_30_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_AIPI_LITE)
    set(BOARD_TYPE "aipi-lite")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
    set(DEFAULT_EMOJI_COLLECTION twemoji_32)
elseif(CONFIG_BOARD_TYPE_HU_087)
    set(BOARD_TYPE "hu-087")
    set(BUILTIN_TEXT_FONT font_puhui_basic_14_1)
    set(BUILTIN_ICON_FONT font_awesome_14_1)
elseif(CONFIG_BOARD_TYPE_Freenove_ESP32S3_DISPLAY_2_8_LCD)
    set(BOARD_TYPE "freenove-esp32s3-display-2.8-lcd")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
elseif(CONFIG_BOARD_TYPE_AI_VOX3)
    set(BOARD_TYPE "nulllab-ai-vox-v3")
    set(BUILTIN_TEXT_FONT font_puhui_basic_20_4)
    set(BUILTIN_ICON_FONT font_awesome_20_4)
    set(DEFAULT_EMOJI_COLLECTION twemoji_64)
endif()

if(MANUFACTURER)
    file(GLOB BOARD_SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/boards/${MANUFACTURER}/${BOARD_TYPE}/*.cc
        ${CMAKE_CURRENT_SOURCE_DIR}/boards/${MANUFACTURER}/${BOARD_TYPE}/*.c
    )
else()
    file(GLOB BOARD_SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/boards/${BOARD_TYPE}/*.cc
        ${CMAKE_CURRENT_SOURCE_DIR}/boards/${BOARD_TYPE}/*.c
    )
endif()
list(APPEND SOURCES ${BOARD_SOURCES})

# Select audio processor according to Kconfig
if(CONFIG_USE_AUDIO_PROCESSOR)
    list(APPEND SOURCES "audio/processors/afe_audio_processor.cc")
else()
    list(APPEND SOURCES "audio/processors/no_audio_processor.cc")
endif()
if(CONFIG_IDF_TARGET_ESP32S3 OR CONFIG_IDF_TARGET_ESP32P4)
    list(APPEND SOURCES "audio/wake_words/afe_wake_word.cc")
    list(APPEND SOURCES "audio/wake_words/custom_wake_word.cc")
else()
    list(APPEND SOURCES "audio/wake_words/esp_wake_word.cc")
endif()

# Auto Select Additional Sources
if (CONFIG_USE_ESP_BLUFI_WIFI_PROVISIONING)
    list(APPEND SOURCES "boards/common/blufi.cpp")
endif ()
# Select language directory according to Kconfig
if(CONFIG_LANGUAGE_ZH_CN)
    set(LANG_DIR "zh-CN")
elseif(CONFIG_LANGUAGE_ZH_TW)
    set(LANG_DIR "zh-TW")
elseif(CONFIG_LANGUAGE_EN_US)
    set(LANG_DIR "en-US")
elseif(CONFIG_LANGUAGE_JA_JP)
    set(LANG_DIR "ja-JP")
elseif(CONFIG_LANGUAGE_KO_KR)
    set(LANG_DIR "ko-KR")
elseif(CONFIG_LANGUAGE_VI_VN)
    set(LANG_DIR "vi-VN")
elseif(CONFIG_LANGUAGE_TH_TH)
    set(LANG_DIR "th-TH")
elseif(CONFIG_LANGUAGE_DE_DE)
    set(LANG_DIR "de-DE")
elseif(CONFIG_LANGUAGE_FR_FR)
    set(LANG_DIR "fr-FR")
elseif(CONFIG_LANGUAGE_ES_ES)
    set(LANG_DIR "es-ES")
elseif(CONFIG_LANGUAGE_IT_IT)
    set(LANG_DIR "it-IT")
elseif(CONFIG_LANGUAGE_RU_RU)
    set(LANG_DIR "ru-RU")
elseif(CONFIG_LANGUAGE_AR_SA)
    set(LANG_DIR "ar-SA")
elseif(CONFIG_LANGUAGE_HI_IN)
    set(LANG_DIR "hi-IN")
elseif(CONFIG_LANGUAGE_PT_PT)
    set(LANG_DIR "pt-PT")
elseif(CONFIG_LANGUAGE_PL_PL)
    set(LANG_DIR "pl-PL")
elseif(CONFIG_LANGUAGE_CS_CZ)
    set(LANG_DIR "cs-CZ")
elseif(CONFIG_LANGUAGE_FI_FI)
    set(LANG_DIR "fi-FI")
elseif(CONFIG_LANGUAGE_TR_TR)
    set(LANG_DIR "tr-TR")
elseif(CONFIG_LANGUAGE_ID_ID)
    set(LANG_DIR "id-ID")
elseif(CONFIG_LANGUAGE_UK_UA)
    set(LANG_DIR "uk-UA")
elseif(CONFIG_LANGUAGE_RO_RO)
    set(LANG_DIR "ro-RO")
elseif(CONFIG_LANGUAGE_BG_BG)
    set(LANG_DIR "bg-BG")
elseif(CONFIG_LANGUAGE_CA_ES)
    set(LANG_DIR "ca-ES")
elseif(CONFIG_LANGUAGE_DA_DK)
    set(LANG_DIR "da-DK")
elseif(CONFIG_LANGUAGE_EL_GR)
    set(LANG_DIR "el-GR")
elseif(CONFIG_LANGUAGE_FA_IR)
    set(LANG_DIR "fa-IR")
elseif(CONFIG_LANGUAGE_FIL_PH)
    set(LANG_DIR "fil-PH")
elseif(CONFIG_LANGUAGE_HE_IL)
    set(LANG_DIR "he-IL")
elseif(CONFIG_LANGUAGE_HR_HR)
    set(LANG_DIR "hr-HR")
elseif(CONFIG_LANGUAGE_HU_HU)
    set(LANG_DIR "hu-HU")
elseif(CONFIG_LANGUAGE_MS_MY)
    set(LANG_DIR "ms-MY")
elseif(CONFIG_LANGUAGE_NB_NO)
    set(LANG_DIR "nb-NO")
elseif(CONFIG_LANGUAGE_NL_NL)
    set(LANG_DIR "nl-NL")
elseif(CONFIG_LANGUAGE_SK_SK)
    set(LANG_DIR "sk-SK")
elseif(CONFIG_LANGUAGE_SL_SI)
    set(LANG_DIR "sl-SI")
elseif(CONFIG_LANGUAGE_SV_SE)
    set(LANG_DIR "sv-SE")
elseif(CONFIG_LANGUAGE_SR_RS)
    set(LANG_DIR "sr-RS")
endif()

# Define generation path
set(LANG_JSON "${CMAKE_CURRENT_SOURCE_DIR}/assets/locales/${LANG_DIR}/language.json")
set(LANG_HEADER "${CMAKE_CURRENT_SOURCE_DIR}/assets/lang_config.h")

# Collect current language audio files
file(GLOB LANG_SOUNDS ${CMAKE_CURRENT_SOURCE_DIR}/assets/locales/${LANG_DIR}/*.ogg)

# If not en-US, collect en-US audio files as fallback for missing files
if(NOT LANG_DIR STREQUAL "en-US")
    file(GLOB EN_US_SOUNDS ${CMAKE_CURRENT_SOURCE_DIR}/assets/locales/en-US/*.ogg)

    # Extract filenames (without path) from current language
    set(EXISTING_NAMES "")
    foreach(SOUND_FILE ${LANG_SOUNDS})
        get_filename_component(FILENAME ${SOUND_FILE} NAME)
        list(APPEND EXISTING_NAMES ${FILENAME})
    endforeach()

    # Only add en-US audio files that are missing in current language
    foreach(EN_SOUND ${EN_US_SOUNDS})
        get_filename_component(FILENAME ${EN_SOUND} NAME)
        if(NOT ${FILENAME} IN_LIST EXISTING_NAMES)
            list(APPEND LANG_SOUNDS ${EN_SOUND})
            message(STATUS "Using en-US fallback for missing audio: ${FILENAME}")
        endif()
    endforeach()
endif()

file(GLOB COMMON_SOUNDS ${CMAKE_CURRENT_SOURCE_DIR}/assets/common/*.ogg)

# If target chip is ESP32, exclude specific files to avoid build errors
if(CONFIG_IDF_TARGET_ESP32)
    list(REMOVE_ITEM SOURCES "audio/codecs/box_audio_codec.cc"
                             "audio/codecs/es8388_audio_codec.cc"
                             "audio/codecs/es8389_audio_codec.cc"
                             "led/gpio_led.cc"
                             "display/lvgl_display/jpg/image_to_jpeg.cpp"
                             "display/lvgl_display/jpg/jpeg_to_image.c"
                             "boards/common/nt26_board.cc"
                             "boards/common/ml307_board.cc"
                             "boards/common/dual_network_board.cc"
                             )
endif()

# Include EspVideo if target is ESP32S3 or ESP32P4
# v2 rescope: dropped esp_video.cc — uses McpServer.
if(CONFIG_IDF_TARGET_ESP32S3 OR CONFIG_IDF_TARGET_ESP32P4)
    list(APPEND SOURCES "boards/common/rndis_board.cc"
                        )
endif()

# Include Esp32Camera if target is ESP32S3
# v2 rescope: dropped esp32_camera.cc — uses McpServer.

set(MAIN_PRIV_REQUIRES_EXTRA "")
if(CONFIG_BOARD_TYPE_ESP_VOCAT)
    list(APPEND MAIN_PRIV_REQUIRES_EXTRA
        espressif__touch_slider_sensor
        espressif__touch_button_sensor
    )
endif()

# Explicit, operator-supplied development trust. Never embed it in release,
# even when the private file remains present. EMBED_TXTFILES null-terminates it.
set(SENTIENT_EMBED_TXTFILES "")
set(SENTIENT_DEV_TLS_CERT 0)
if(CONFIG_BOARD_TYPE_SENTIENT_CUBE AND NOT CONFIG_SENTIENT_PROD_BUILD AND
   EXISTS "${CMAKE_CURRENT_LIST_DIR}/sentient_dev_gateway.crt")
    list(APPEND SENTIENT_EMBED_TXTFILES "sentient_dev_gateway.crt")
    set(SENTIENT_DEV_TLS_CERT 1)
    message(STATUS "sentient-cube: embedding supplied development TLS certificate")
endif()

if(CONFIG_BOARD_TYPE_SENTIENT_CUBE)
    list(APPEND SOURCES "asset_archive.cc" "../ui-shared/companion.cc" "../ui-shared/cube_views.cc")
    list(APPEND INCLUDE_DIRS "boards/sentient-cube")
endif()

idf_component_register(SRCS ${SOURCES}
                    EMBED_FILES ${LANG_SOUNDS} ${COMMON_SOUNDS}
                    EMBED_TXTFILES ${SENTIENT_EMBED_TXTFILES}
                    INCLUDE_DIRS ${INCLUDE_DIRS}
                    WHOLE_ARCHIVE
                    PRIV_REQUIRES
                        cube_envelope
                        protocomm
                        esp_http_client
                        nvs_flash
                        esp_pm
                        esp_psram
                        esp_netif
                        esp_driver_gpio
                        esp_driver_uart
                        esp_driver_spi
                        esp_driver_i2c
                        esp_driver_i2s
                        esp_driver_jpeg
                        esp_driver_ppa
                        esp_app_format
                        app_update
                        spi_flash
                        console
                        efuse
                        bt
                        fatfs
                        # Phase 6a: SentientWsProtocol speaks the sentient
                        # gateway WS directly via esp_websocket_client.
                        espressif__esp_websocket_client
                        # 78__esp-ml307 supplies network abstractions used by
                        # board and assets code; expose its src/ headers below.
                        78__esp-ml307
                        ${MAIN_PRIV_REQUIRES_EXTRA}
                    )

if(CONFIG_BOARD_TYPE_SENTIENT_CUBE)
    if(NOT CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM
       OR NOT CONFIG_MBEDTLS_HAVE_TIME_DATE OR NOT CONFIG_ESP_HTTP_CLIENT_ENABLE_HTTPS
       OR NOT CONFIG_ESP_HTTP_CLIENT_ENABLE_CUSTOM_TRANSPORT
       OR NOT CONFIG_BT_NIMBLE_ENABLED OR NOT CONFIG_BT_NIMBLE_MEM_ALLOC_MODE_EXTERNAL
       OR NOT CONFIG_BT_NIMBLE_MAX_CONNECTIONS EQUAL 1 OR CONFIG_BT_NIMBLE_HOST_TASK_STACK_SIZE LESS 8192
       OR CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_0 OR CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_1)
        message(FATAL_ERROR "Cube requires PSRAM-capable task stacks, TLS date verification, HTTPS/custom transport, Security2-only NimBLE, external allocation, one connection, and host stack >=8192. Apply current sdkconfig.defaults to the selected build profile.")
    endif()
    # Upstream SRP/Security2 DEBUG hexdumps contain session/private keys. Compile
    # them out even when an operator enables verbose diagnostics at runtime.
    idf_component_get_property(PROTOCOMM_LIB protocomm COMPONENT_LIB)
    target_compile_definitions(${PROTOCOMM_LIB} PRIVATE LOG_LOCAL_LEVEL=ESP_LOG_NONE)
    idf_component_get_property(HTTP_CLIENT_LIB esp_http_client COMPONENT_LIB)
    target_compile_definitions(${HTTP_CLIENT_LIB} PRIVATE LOG_LOCAL_LEVEL=ESP_LOG_WARN)
    # IDF 5.5.2: salt width, SRP input/error handling, and Security2 ownership.
    # Hash-pinned build-local corrections; never mutate the installed SDK.
    idf_component_get_property(PROTOCOMM_DIR protocomm COMPONENT_DIR)
    set(SRP_SOURCE "${PROTOCOMM_DIR}/src/crypto/srp6a/esp_srp.c")
    set(SRP_PATCHED "${CMAKE_CURRENT_BINARY_DIR}/cube_esp_srp.c")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                 "${SRP_SOURCE}" "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_srp_security.py")
    execute_process(COMMAND ${PYTHON} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_srp_security.py"
                    "${SRP_SOURCE}" "${SRP_PATCHED}" COMMAND_ERROR_IS_FATAL ANY)
    set(SEC2_SOURCE "${PROTOCOMM_DIR}/src/security/security2.c")
    set(SEC2_PATCHED "${CMAKE_CURRENT_BINARY_DIR}/cube_security2.c")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                 "${SEC2_SOURCE}" "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_security2.py"
                 "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_srp_salt.py")
    execute_process(COMMAND ${PYTHON} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_security2.py"
                    "${SEC2_SOURCE}" "${SEC2_PATCHED}" COMMAND_ERROR_IS_FATAL ANY)
    set(MPI_SOURCE "${PROTOCOMM_DIR}/src/crypto/srp6a/esp_srp_mpi.c")
    set(MPI_PATCHED "${CMAKE_CURRENT_BINARY_DIR}/cube_esp_srp_mpi.c")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                 "${MPI_SOURCE}" "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_srp_mpi.py")
    execute_process(COMMAND ${PYTHON} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_srp_mpi.py"
                    "${MPI_SOURCE}" "${MPI_PATCHED}" COMMAND_ERROR_IS_FATAL ANY)
    get_target_property(PROTOCOMM_SOURCES ${PROTOCOMM_LIB} SOURCES)
    list(FILTER PROTOCOMM_SOURCES EXCLUDE REGEX "(^|/)(esp_srp|esp_srp_mpi|security2)\\.c$")
    set_property(TARGET ${PROTOCOMM_LIB} PROPERTY SOURCES "${PROTOCOMM_SOURCES}")
    target_sources(${PROTOCOMM_LIB} PRIVATE "${SRP_PATCHED}" "${SEC2_PATCHED}" "${MPI_PATCHED}")
    target_include_directories(${PROTOCOMM_LIB} PRIVATE "${PROTOCOMM_DIR}/src/crypto/srp6a")
    # Async select must rebuild fd sets after timeout; preserve TLS error codes.
    foreach(TLS_COMPONENT esp-tls tcp_transport)
        if(TLS_COMPONENT STREQUAL "esp-tls")
            set(TLS_FILE esp_tls.c)
        else()
            set(TLS_FILE transport_ssl.c)
        endif()
        idf_component_get_property(TLS_DIR ${TLS_COMPONENT} COMPONENT_DIR)
        idf_component_get_property(TLS_LIB ${TLS_COMPONENT} COMPONENT_LIB)
        set(TLS_SOURCE "${TLS_DIR}/${TLS_FILE}")
        set(TLS_PATCHED "${CMAKE_CURRENT_BINARY_DIR}/cube_${TLS_FILE}")
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                     "${TLS_SOURCE}" "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_tls_async.py")
        execute_process(COMMAND ${PYTHON} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_tls_async.py"
                        "${TLS_SOURCE}" "${TLS_PATCHED}" COMMAND_ERROR_IS_FATAL ANY)
        get_target_property(TLS_SOURCES ${TLS_LIB} SOURCES)
        list(FILTER TLS_SOURCES EXCLUDE REGEX "(^|/)${TLS_FILE}$")
        set_property(TARGET ${TLS_LIB} PROPERTY SOURCES "${TLS_SOURCES}")
        target_sources(${TLS_LIB} PRIVATE "${TLS_PATCHED}")
    endforeach()
    # SDK exposes stack size but not memory caps. Cube WS callbacks do not write
    # flash; use supported caps creation/deletion without changing the dependency.
    idf_component_get_property(WS_DIR espressif__esp_websocket_client COMPONENT_DIR)
    idf_component_get_property(WS_LIB espressif__esp_websocket_client COMPONENT_LIB)
    set(WS_SOURCE "${WS_DIR}/esp_websocket_client.c")
    set(WS_PATCHED "${CMAKE_CURRENT_BINARY_DIR}/cube_esp_websocket_client.c")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                 "${WS_SOURCE}" "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_websocket_stack.py")
    execute_process(COMMAND ${PYTHON} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_websocket_stack.py"
                    "${WS_SOURCE}" "${WS_PATCHED}" COMMAND_ERROR_IS_FATAL ANY)
    get_target_property(WS_SOURCES ${WS_LIB} SOURCES)
    list(FILTER WS_SOURCES EXCLUDE REGEX "(^|/)esp_websocket_client\\.c$")
    set_property(TARGET ${WS_LIB} PROPERTY SOURCES "${WS_SOURCES}")
    target_sources(${WS_LIB} PRIVATE "${WS_PATCHED}")
    # Propagate failed I2S/DMA format setup before enabling either channel.
    idf_component_get_property(CODEC_DIR espressif__esp_codec_dev COMPONENT_DIR)
    idf_component_get_property(CODEC_LIB espressif__esp_codec_dev COMPONENT_LIB)
    target_include_directories(${CODEC_LIB} PRIVATE "${CODEC_DIR}")
    foreach(CODEC_FILE esp_codec_dev.c platform/audio_codec_data_i2s.c)
        get_filename_component(CODEC_NAME "${CODEC_FILE}" NAME)
        set(CODEC_SOURCE "${CODEC_DIR}/${CODEC_FILE}")
        set(CODEC_PATCHED "${CMAKE_CURRENT_BINARY_DIR}/cube_${CODEC_NAME}")
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                     "${CODEC_SOURCE}" "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_codec_errors.py")
        execute_process(COMMAND ${PYTHON} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/patch_codec_errors.py"
                        "${CODEC_SOURCE}" "${CODEC_PATCHED}" COMMAND_ERROR_IS_FATAL ANY)
        get_target_property(CODEC_SOURCES ${CODEC_LIB} SOURCES)
        list(FILTER CODEC_SOURCES EXCLUDE REGEX "(^|/)${CODEC_NAME}$")
        set_property(TARGET ${CODEC_LIB} PROPERTY SOURCES "${CODEC_SOURCES}")
        target_sources(${CODEC_LIB} PRIVATE "${CODEC_PATCHED}")
    endforeach()
    idf_component_get_property(EMOTE_GFX_DIR espressif2022__esp_emote_gfx COMPONENT_DIR)
    target_include_directories(${COMPONENT_LIB} PRIVATE "${EMOTE_GFX_DIR}/src/lib/qrcode")
endif()

# Expose esp-ml307 src/ headers used by board and assets code; the
# component's private include directory is not propagated to main.
idf_component_get_property(ML307_DIR 78__esp-ml307 COMPONENT_DIR)
target_include_directories(${COMPONENT_LIB} PRIVATE "${ML307_DIR}/src")

# Use target_compile_definitions to define BOARD_TYPE, BOARD_NAME
# If BOARD_NAME is empty, use BOARD_TYPE
if(NOT BOARD_NAME)
    set(BOARD_NAME ${BOARD_TYPE})
endif()
target_compile_definitions(${COMPONENT_LIB}
                    PRIVATE SENTIENT_DEV_TLS_CERT=${SENTIENT_DEV_TLS_CERT}
                    PRIVATE BOARD_TYPE=\"${BOARD_TYPE}\" BOARD_NAME=\"${BOARD_NAME}\"
                    PRIVATE BUILTIN_TEXT_FONT=${BUILTIN_TEXT_FONT} BUILTIN_ICON_FONT=${BUILTIN_ICON_FONT}
                    )

# Add generation rules
add_custom_command(
    OUTPUT ${LANG_HEADER}
    COMMAND python ${PROJECT_DIR}/scripts/gen_lang.py
            --language "${LANG_DIR}"
            --output "${LANG_HEADER}"
    DEPENDS
        ${LANG_JSON}
        ${PROJECT_DIR}/scripts/gen_lang.py
    COMMENT "Generating ${LANG_DIR} language config"
)

# Force build generation dependencies
add_custom_target(lang_header ALL
    DEPENDS ${LANG_HEADER}
)

# Find ESP-SR component dynamically
find_component_by_pattern("espressif__esp-sr" ESP_SR_COMPONENT ESP_SR_COMPONENT_PATH)
if(ESP_SR_COMPONENT_PATH)
    set(ESP_SR_MODEL_PATH "${ESP_SR_COMPONENT_PATH}/model")
endif()

# Find xiaozhi-fonts component dynamically
find_component_by_pattern("xiaozhi-fonts" XIAOZHI_FONTS_COMPONENT XIAOZHI_FONTS_COMPONENT_PATH)
if(XIAOZHI_FONTS_COMPONENT_PATH)
    set(XIAOZHI_FONTS_PATH "${XIAOZHI_FONTS_COMPONENT_PATH}")
endif()

if(CONFIG_BOARD_TYPE_ESP_HI)
set(URL "https://github.com/espressif2022/image_player/raw/main/test_apps/test_8bit")
set(EMOJI_DIR "${CMAKE_BINARY_DIR}/emoji")
file(MAKE_DIRECTORY ${EMOJI_DIR})

# List all files to download
set(FILES_TO_DOWNLOAD "")
list(APPEND FILES_TO_DOWNLOAD "Anger_enter.aaf" "Anger_loop.aaf" "Anger_return.aaf")
list(APPEND FILES_TO_DOWNLOAD "happy_enter.aaf" "happy_loop.aaf" "happ_return.aaf")
list(APPEND FILES_TO_DOWNLOAD "sad_enter.aaf" "sad_loop.aaf" "sad_return.aaf")
list(APPEND FILES_TO_DOWNLOAD "scorn_enter.aaf" "scorn_loop.aaf" "scorn_return.aaf")
list(APPEND FILES_TO_DOWNLOAD "left_enter.aaf" "left_loop.aaf" "left_return.aaf")
list(APPEND FILES_TO_DOWNLOAD "right_enter.aaf" "right_loop.aaf" "right_return.aaf")
list(APPEND FILES_TO_DOWNLOAD "asking.aaf" "blink_once.aaf" "blink_quick.aaf")
list(APPEND FILES_TO_DOWNLOAD "connecting.aaf" "panic_enter.aaf" "panic_loop.aaf")
list(APPEND FILES_TO_DOWNLOAD "panic_return.aaf" "wake.aaf")

foreach(FILENAME IN LISTS FILES_TO_DOWNLOAD)
    set(REMOTE_FILE "${URL}/${FILENAME}")
    set(LOCAL_FILE "${EMOJI_DIR}/${FILENAME}")

    # Check if local file exists
    if(EXISTS ${LOCAL_FILE})
        message(STATUS "File ${FILENAME} already exists, skipping download")
    else()
        message(STATUS "Downloading ${FILENAME}")
        file(DOWNLOAD ${REMOTE_FILE} ${LOCAL_FILE}
             STATUS DOWNLOAD_STATUS)
        list(GET DOWNLOAD_STATUS 0 STATUS_CODE)
        if(NOT STATUS_CODE EQUAL 0)
            message(FATAL_ERROR "Failed to download ${FILENAME} from ${URL}")
        endif()
    endif()
endforeach()

endif()


# Function to build default assets based on configuration
function(build_default_assets_bin)
    # Set output path for generated assets.bin
    set(GENERATED_ASSETS_BIN "${CMAKE_BINARY_DIR}/generated_assets.bin")

    # Prepare arguments for build script
    set(BUILD_ARGS
        "--sdkconfig" "${SDKCONFIG}"
        "--output" "${GENERATED_ASSETS_BIN}"
    )

    # Add builtin text font if defined
    if(BUILTIN_TEXT_FONT)
        list(APPEND BUILD_ARGS "--builtin_text_font" "${BUILTIN_TEXT_FONT}")
    endif()

    # Add default emoji collection if defined
    if(DEFAULT_EMOJI_COLLECTION)
        list(APPEND BUILD_ARGS "--emoji_collection" "${DEFAULT_EMOJI_COLLECTION}")
    endif()

    # Add default assets extra files if defined
    if(DEFAULT_ASSETS_EXTRA_FILES)
        list(APPEND BUILD_ARGS "--extra_files" "${DEFAULT_ASSETS_EXTRA_FILES}")
    endif()

    list(APPEND BUILD_ARGS "--esp_sr_model_path" "${ESP_SR_MODEL_PATH}")
    list(APPEND BUILD_ARGS "--xiaozhi_fonts_path" "${XIAOZHI_FONTS_PATH}")

    # Create custom command to build assets
    add_custom_command(
        OUTPUT ${GENERATED_ASSETS_BIN}
        COMMAND python ${PROJECT_DIR}/scripts/build_default_assets.py ${BUILD_ARGS}
        DEPENDS
            ${SDKCONFIG}
            ${PROJECT_DIR}/scripts/build_default_assets.py
        COMMENT "Building default assets.bin based on configuration"
        VERBATIM
    )

    # Create target for generated assets
    add_custom_target(generated_default_assets ALL
        DEPENDS ${GENERATED_ASSETS_BIN}
    )

    # Set the generated file path in parent scope
    set(GENERATED_ASSETS_LOCAL_FILE ${GENERATED_ASSETS_BIN} PARENT_SCOPE)

    message(STATUS "Default assets build configured: ${GENERATED_ASSETS_BIN}")
endfunction()


# Function to get local assets file path (handles both URL and local file)
function(get_assets_local_file assets_source assets_local_file_var)
    # Check if it's a URL (starts with http:// or https://)
    if(assets_source MATCHES "^https?://")
        # It's a URL, download it
        get_filename_component(ASSETS_FILENAME "${assets_source}" NAME)
        set(ASSETS_LOCAL_FILE "${CMAKE_BINARY_DIR}/${ASSETS_FILENAME}")
        set(ASSETS_TEMP_FILE "${CMAKE_BINARY_DIR}/${ASSETS_FILENAME}.tmp")

        # Check if local file exists
        if(EXISTS ${ASSETS_LOCAL_FILE})
            message(STATUS "Assets file ${ASSETS_FILENAME} already exists, skipping download")
        else()
            message(STATUS "Downloading ${ASSETS_FILENAME}")

            # Clean up any existing temp file
            if(EXISTS ${ASSETS_TEMP_FILE})
                file(REMOVE ${ASSETS_TEMP_FILE})
            endif()

            # Download to temporary file first
            file(DOWNLOAD ${assets_source} ${ASSETS_TEMP_FILE}
                 STATUS DOWNLOAD_STATUS)
            list(GET DOWNLOAD_STATUS 0 STATUS_CODE)
            if(NOT STATUS_CODE EQUAL 0)
                # Clean up temp file on failure
                if(EXISTS ${ASSETS_TEMP_FILE})
                    file(REMOVE ${ASSETS_TEMP_FILE})
                endif()
                message(FATAL_ERROR "Failed to download ${ASSETS_FILENAME} from ${assets_source}")
            endif()

            # Move temp file to final location (atomic operation)
            file(RENAME ${ASSETS_TEMP_FILE} ${ASSETS_LOCAL_FILE})
            message(STATUS "Successfully downloaded ${ASSETS_FILENAME}")
        endif()
    else()
        # It's a local file path
        if(IS_ABSOLUTE "${assets_source}")
            set(ASSETS_LOCAL_FILE "${assets_source}")
        else()
            set(ASSETS_LOCAL_FILE "${CMAKE_CURRENT_SOURCE_DIR}/${assets_source}")
        endif()

        # Check if local file exists
        if(NOT EXISTS ${ASSETS_LOCAL_FILE})
            message(FATAL_ERROR "Assets file not found: ${ASSETS_LOCAL_FILE}")
        endif()

        message(STATUS "Using assets file: ${ASSETS_LOCAL_FILE}")
    endif()

    set(${assets_local_file_var} ${ASSETS_LOCAL_FILE} PARENT_SCOPE)
endfunction()


if(CONFIG_BOARD_TYPE_SENTIENT_CUBE)
    if(CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE)
        message(FATAL_ERROR "Cube is USB-only: disable CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE")
    endif()
    set(CUBE_ASSETS_BIN "${CMAKE_BINARY_DIR}/cube_assets.bin")
    file(GLOB CUBE_ASSET_INPUTS CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/boards/sentient-cube/character/*.i1"
        "${CMAKE_CURRENT_SOURCE_DIR}/boards/sentient-cube/character/*.rgb565")
    # Reuse full-font selection and configured SR model cooking. Cube does not
    # consume the upstream emoji collection; do not cook that unused payload.
    file(GLOB_RECURSE CUBE_MODEL_INPUTS CONFIGURE_DEPENDS "${ESP_SR_MODEL_PATH}/*")
    file(GLOB CUBE_FONT_INPUTS CONFIGURE_DEPENDS "${XIAOZHI_FONTS_PATH}/cbin/*.bin")
    add_custom_command(OUTPUT "${CUBE_ASSETS_BIN}"
        COMMAND ${PYTHON} "${PROJECT_DIR}/scripts/build_default_assets.py"
            --sdkconfig "${SDKCONFIG}"
            --builtin_text_font "${BUILTIN_TEXT_FONT}"
            --esp_sr_model_path "${ESP_SR_MODEL_PATH}"
            --xiaozhi_fonts_path "${XIAOZHI_FONTS_PATH}"
            --cube-board "${CMAKE_CURRENT_SOURCE_DIR}/boards/sentient-cube"
            --output "${CUBE_ASSETS_BIN}"
        DEPENDS ${SDKCONFIG} ${CUBE_ASSET_INPUTS} ${CUBE_MODEL_INPUTS} ${CUBE_FONT_INPUTS}
            "${CMAKE_CURRENT_SOURCE_DIR}/boards/sentient-cube/companion.json"
            "${PROJECT_DIR}/scripts/build_default_assets.py"
            "${PROJECT_DIR}/scripts/cook_cube_assets.py"
        VERBATIM)
    add_custom_target(cube_bundled_assets DEPENDS "${CUBE_ASSETS_BIN}")
    add_dependencies(${COMPONENT_LIB} cube_bundled_assets)
    target_add_binary_data(${COMPONENT_LIB} "${CUBE_ASSETS_BIN}" BINARY)
else()
partition_table_get_partition_info(size "--partition-name assets" "size")
partition_table_get_partition_info(offset "--partition-name assets" "offset")
if ("${size}" AND "${offset}")
    # Flash assets based on configuration
    if(CONFIG_FLASH_DEFAULT_ASSETS)
        # Build default assets based on configuration
        build_default_assets_bin()
        esptool_py_flash_to_partition(flash "assets" "${GENERATED_ASSETS_LOCAL_FILE}")
        message(STATUS "Generated default assets flash configured: ${GENERATED_ASSETS_LOCAL_FILE} -> assets partition")
    elseif(CONFIG_FLASH_CUSTOM_ASSETS)
        # Flash custom assets
        get_assets_local_file("${CONFIG_CUSTOM_ASSETS_FILE}" ASSETS_LOCAL_FILE)
        esptool_py_flash_to_partition(flash "assets" "${ASSETS_LOCAL_FILE}")
        message(STATUS "Custom assets flash configured: ${ASSETS_LOCAL_FILE} -> assets partition")
    elseif(CONFIG_FLASH_EXPRESSION_ASSETS)
        set(ASSETS_NAME "expression_assets")
        set(ASSETS_PARTITION "assets")
        set(ASSETS_FILE "${CMAKE_BINARY_DIR}/${ASSETS_NAME}.bin")

        build_speaker_assets_bin("${ASSETS_PARTITION}" ${EMOTE_RESOLUTION} ${ASSETS_FILE} ${CONFIG_MMAP_FILE_NAME_LENGTH})
        message(STATUS "Generated emote assets: ${ASSETS_FILE} -> ${ASSETS_PARTITION} partition")
        esptool_py_flash_to_partition(flash "${ASSETS_PARTITION}" "${ASSETS_FILE}")
    elseif(CONFIG_FLASH_NONE_ASSETS)
        message(STATUS "Assets flashing disabled (FLASH_NONE_ASSETS)")
    endif()
else()
    message(STATUS "Assets partition not found, using v1 partition table")
endif()

endif()
