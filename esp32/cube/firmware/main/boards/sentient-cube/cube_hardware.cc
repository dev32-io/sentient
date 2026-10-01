#include "cube_hardware.h"
#include "cube_http.h"
#include <cJSON.h>
#include <esp_app_desc.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>
#include <esp_netif.h>
#include <esp_netif_sntp.h>
#include <esp_random.h>
#include <esp_srp.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mbedtls/base64.h>
#include <protocomm_ble.h>
#include <protocomm_security2.h>
#include <host/ble_gap.h>
#include <cmath>
#include <memory>
#include <set>
#include <time.h>

namespace sentient::cube {
namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
std::string text(const cJSON* obj, const char* key) {
    const auto* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) && item->valuestring ? item->valuestring : "";
}
std::string encode(const cJSON* obj) {
    char* value = cJSON_PrintUnformatted(obj);
    if (!value) return "";
    std::string result(value);
    cJSON_free(value);
    return result;
}
Json object() { return Json(cJSON_CreateObject(), cJSON_Delete); }
bool fields(const cJSON* obj, std::initializer_list<const char*> names) {
    if (!cJSON_IsObject(obj)) return false;
    std::set<std::string> allowed;
    for (auto* name : names) allowed.emplace(name);
    const cJSON* item;
    cJSON_ArrayForEach(item, obj) {
        if (!item->string || allowed.erase(item->string) != 1) return false;
    }
    return allowed.empty();
}
uint32_t number(const cJSON* obj, const char* key) {
    const auto* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (!cJSON_IsNumber(item) || item->valuedouble < 1 || item->valuedouble > INT32_MAX ||
        std::floor(item->valuedouble) != item->valuedouble) return 0;
    return static_cast<uint32_t>(item->valuedouble);
}
std::string secret() {
    uint8_t random[32], encoded[45];
    esp_fill_random(random, sizeof(random)); // Called only after Wi-Fi RF is enabled.
    size_t n = 0;
    if (mbedtls_base64_encode(encoded, sizeof(encoded), &n, random, sizeof(random)) != 0) return "";
    std::string result(reinterpret_cast<char*>(encoded), n);
    std::replace(result.begin(), result.end(), '+', '-');
    std::replace(result.begin(), result.end(), '/', '_');
    while (!result.empty() && result.back() == '=') result.pop_back();
    return result;
}
std::string uuid() {
    uint8_t bytes[16];
    esp_fill_random(bytes, sizeof(bytes));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    char result[37];
    snprintf(result, sizeof(result), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
    return result;
}
std::string locator(const CubeEnrollment& r) {
    std::string id = r.device_id;
    id.erase(std::remove(id.begin(), id.end(), '-'), id.end());
    return "SC_" + id.substr(0, 12);
}
esp_err_t verifier(const char* user, const std::string& proof, uint8_t* salt, uint8_t* verify) {
    char *s = nullptr, *v = nullptr;
    int length = 0;
    esp_err_t err = esp_srp_gen_salt_verifier(user, strlen(user), proof.data(), proof.size(), &s, 32, &v, &length);
    if (err == ESP_OK && length > 0 && length <= 384) {
        memcpy(salt, s, 32); // Build-local IDF salt patch guarantees this width.
        memset(verify, 0, 384);
        memcpy(verify + 384 - length, v, length);
    } else if (err == ESP_OK) err = ESP_ERR_INVALID_SIZE;
    free(s); free(v);
    return err;
}
const char* phase(EnrollmentPhase p) {
    switch (p) {
        case EnrollmentPhase::Bootstrap: return "bootstrap";
        case EnrollmentPhase::Pending: return "pending";
        case EnrollmentPhase::Committed: return "committed";
        case EnrollmentPhase::Active: return "active";
    }
    return "invalid";
}
std::string failure(const char* error) {
    auto root = object();
    cJSON_AddNumberToObject(root.get(), "version", 1);
    cJSON_AddBoolToObject(root.get(), "ok", false);
    cJSON_AddStringToObject(root.get(), "error", error);
    return encode(root.get());
}
struct WifiRecord { char ssid[33]{}; char password[65]{}; };
HttpResult request(const CubeEnrollment& record, const char* route) {
    auto body = object();
    cJSON_AddNumberToObject(body.get(), "version", 1);
    cJSON_AddStringToObject(body.get(), "deviceId", record.device_id);
    cJSON_AddStringToObject(body.get(), "attemptId", record.attempt_id);
    cJSON_AddNumberToObject(body.get(), "generation", record.generation);
    cJSON_AddStringToObject(body.get(), "renewalSecret", record.renewal);
    if (!strcmp(route, "redeem")) cJSON_AddStringToObject(body.get(), "enrollmentSecret", record.enrollment);
    auto payload = encode(body.get());
    auto url = cube_text(record.origin) + "/api/v1/devices/" + route;
    esp_http_client_config_t config{};
    config.url = url.c_str();
#if !CONFIG_SENTIENT_PROD_BUILD && SENTIENT_DEV_TLS_CERT
    extern const char dev_cert_pem_start[] asm("_binary_sentient_dev_gateway_crt_start");
    config.cert_pem = dev_cert_pem_start;
#else
    config.crt_bundle_attach = esp_crt_bundle_attach;
#endif
    return cube_http_post(config, payload);
}
}

esp_err_t CubeHardware::Save(const CubeEnrollment& next) {
    auto err = store_.Save(next);
    if (err != ESP_OK) {
        fatal_ = true; token_.clear(); account_attention_ = true; last_error_ = "storage"; ++revision_;
        return err;
    }
    record_ = next;
    ++epoch_;
    return ESP_OK;
}

esp_err_t CubeHardware::Start(std::function<void(bool)> network_event) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto initialize = [&]() -> esp_err_t {
    network_event_ = std::move(network_event);
    auto err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    if (!esp_netif_create_default_wifi_sta()) return ESP_ERR_NO_MEM;
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    config.nvs_enable = false; // Our checked, atomic network blob owns persistence.
    if ((err = esp_wifi_init(&config)) != ESP_OK) return err;
    if ((err = esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, NetworkEvent, this)) != ESP_OK ||
        (err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, NetworkEvent, this)) != ESP_OK) return err;
    if ((err = esp_wifi_set_mode(WIFI_MODE_STA)) != ESP_OK || (err = esp_wifi_start()) != ESP_OK) return err;
    // RF is now active, supplying entropy before generation of ANY credentials.
    err = store_.Open(record_);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        record_ = CubeEnrollment{};
        cube_copy(record_.device_id, uuid());
        cube_copy(record_.bootstrap, secret());
        err = store_.Save(record_);
    }
    if (err != ESP_OK) { last_error_ = "storage"; return err; }
    if (record_.phase == EnrollmentPhase::Bootstrap) {
        auto qr = object();
        cJSON_AddNumberToObject(qr.get(), "version", 1);
        cJSON_AddStringToObject(qr.get(), "deviceId", record_.device_id);
        cJSON_AddStringToObject(qr.get(), "name", locator(record_).c_str());
        cJSON_AddStringToObject(qr.get(), "transport", "ble");
        cJSON_AddNumberToObject(qr.get(), "security", 2);
        cJSON_AddStringToObject(qr.get(), "username", "cube-bootstrap");
        cJSON_AddStringToObject(qr.get(), "pop", record_.bootstrap);
        qr_ = encode(qr.get());
    }
    err = nvs_open("cube_wifi", NVS_READWRITE, &wifi_nvs_);
    if (err != ESP_OK) { fatal_ = true; last_error_ = "storage"; return err; }
    WifiRecord wifi;
    size_t size = sizeof(wifi);
    err = nvs_get_blob(wifi_nvs_, "network", &wifi, &size);
    if (err == ESP_OK && size == sizeof(wifi) && cube_wifi(cube_text(wifi.ssid), cube_text(wifi.password))) {
        memcpy(wifi_config_.sta.ssid, wifi.ssid, strnlen(wifi.ssid, 32));
        memcpy(wifi_config_.sta.password, wifi.password, strnlen(wifi.password, 64));
        have_wifi_ = true; apply_wifi_ = true;
    } else if (err != ESP_ERR_NVS_NOT_FOUND) {
        last_error_ = "wifi-storage"; // Recover network only through authenticated manager.
    }
    esp_sntp_config_t ntp = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_CUBE_NTP_SERVER);
    ntp.start = false;
    if ((err = esp_netif_sntp_init(&ntp)) != ESP_OK) return err;
    if ((err = esp_event_handler_register(PROTOCOMM_TRANSPORT_BLE_EVENT, ESP_EVENT_ANY_ID, BleEvent, this)) != ESP_OK ||
        (err = esp_event_handler_register(PROTOCOMM_SECURITY_SESSION_EVENT, ESP_EVENT_ANY_ID, BleEvent, this)) != ESP_OK) return err;
    sync_requested_ = record_.phase != EnrollmentPhase::Bootstrap;
    if (xTaskCreate([](void* arg) { static_cast<CubeHardware*>(arg)->Run(); }, "cube-hardware", 10240,
                    this, 3, nullptr) != pdPASS) return ESP_ERR_NO_MEM;
    return ESP_OK;
    };
    auto err = initialize();
    if (err != ESP_OK) { fatal_ = true; account_attention_ = true; if (last_error_.empty()) last_error_ = "hardware-unavailable"; }
    return err;
}
void CubeHardware::BleEvent(void* arg, esp_event_base_t base, int32_t id, void* data) {
    auto& self = *static_cast<CubeHardware*>(arg);
    if (base == PROTOCOMM_TRANSPORT_BLE_EVENT) {
        if (id == PROTOCOMM_TRANSPORT_BLE_CONNECTED && data) {
            auto* event = static_cast<protocomm_ble_event_t*>(data);
            if (event->conn_status == 0) {
                self.ble_handle_ = event->conn_handle;
                self.ble_authenticated_ = false;
                self.ble_deadline_ = esp_timer_get_time() + 20000000;
            }
        } else if (id == PROTOCOMM_TRANSPORT_BLE_DISCONNECTED) {
            self.ble_handle_ = -1; self.ble_deadline_ = 0; self.ble_authenticated_ = false;
        }
    } else if (self.ble_handle_ >= 0) {
        self.ble_authenticated_ = id == PROTOCOMM_SECURITY_SESSION_SETUP_OK;
        self.ble_deadline_ = esp_timer_get_time() +
            (id == PROTOCOMM_SECURITY_SESSION_SETUP_OK ? CONFIG_CUBE_BLE_SESSION_SECONDS * 1000000ULL : 0);
    }
}
void CubeHardware::NetworkEvent(void* arg, esp_event_base_t base, int32_t id, void*) {
    auto& self = *static_cast<CubeHardware*>(arg);
    const bool online = base == IP_EVENT && id == IP_EVENT_STA_GOT_IP;
    self.wifi_connected_ = online;
    if (online) self.wifi_state_ = WifiState::Connected;
    if (!online) self.gateway_ready_ = false;
    else { esp_netif_sntp_start(); self.RequestSync(); }
    if (self.network_event_) self.network_event_(online);
}
void CubeHardware::RequestSync() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (fatal_ || account_attention_ || record_.phase == EnrollmentPhase::Bootstrap || syncing_) return;
    sync_requested_ = true; sync_attempts_ = 0; next_sync_ = 0;
}
CubeConnection CubeHardware::Connection() {
    std::lock_guard<std::mutex> lock(mutex_);
    CubeConnection result;
    result.blocked = fatal_ || account_attention_ || record_.phase != EnrollmentPhase::Active || token_.empty();
    result.revision = revision_;
    if (!result.blocked) {
        result.device_id = record_.device_id;
        result.url = "wss://" + cube_text(record_.origin).substr(8) + record_.ws_path;
        result.token = token_;
    }
    return result;
}
CubePresentation CubeHardware::Presentation() {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool setup = !fatal_ && record_.phase == EnrollmentPhase::Bootstrap;
    return { setup,
        !fatal_ && !account_attention_ && record_.phase != EnrollmentPhase::Bootstrap && record_.phase != EnrollmentPhase::Active,
        fatal_ || account_attention_, setup ? qr_ : "", setup ? locator(record_) : "",
        setup ? cube_text(record_.bootstrap) : "" };
}
void CubeHardware::WsStartResult(const char* phase, esp_err_t error) {
    std::lock_guard<std::mutex> lock(mutex_);
    ws_start_phase_ = phase;
    ws_start_error_ = error;
}
CubeHardwareStatus CubeHardware::Status() {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto wifi = wifi_state_.load();
    return {phase(record_.phase), last_error_, fatal_, account_attention_, ble_active_,
        ble_handle_ >= 0, ble_authenticated_, wifi_connected_, gateway_ready_,
        wifi == WifiState::Offline ? "offline" : wifi == WifiState::Joining ? "joining" :
        wifi == WifiState::Connected ? "connected" : "failed", http_, ws_start_phase_, ws_start_error_};
}

esp_err_t CubeHardware::StartBle() {
    CubeEnrollment snapshot;
    { std::lock_guard<std::mutex> lock(mutex_); if (fatal_) return ESP_ERR_INVALID_STATE; snapshot = record_; }
    ble_bootstrap_ = snapshot.phase == EnrollmentPhase::Bootstrap;
    esp_err_t err = ESP_OK;
    if (ble_bootstrap_) err = verifier("cube-bootstrap", snapshot.bootstrap, ble_salt_, ble_verifier_);
    else { memcpy(ble_salt_, snapshot.salt, 32); memcpy(ble_verifier_, snapshot.verifier, 384); }
    if (err != ESP_OK) return err;
    pc_ = protocomm_new();
    if (!pc_) return ESP_ERR_NO_MEM;
    protocomm_security2_params_t security{reinterpret_cast<char*>(ble_salt_), 32,
                                        reinterpret_cast<char*>(ble_verifier_), 384};
    static protocomm_ble_name_uuid_t endpoints[] = {{"prov-session", 0xff51}, {"proto-ver", 0xff52}, {"cube-control", 0xff53}};
    protocomm_ble_config_t config{};
    snprintf(config.device_name, sizeof(config.device_name), "%s", locator(snapshot).c_str());
    const uint8_t service[] = {0x1a,0xd7,0x90,0x04,0x03,0x82,0x4a,0xea,0xbf,0xf4,0x6b,0x3f,0x1c,0x5a,0xdf,0xb4};
    memcpy(config.service_uuid, service, sizeof(service));
    config.nu_lookup_count = 3; config.nu_lookup = endpoints;
    // No pairing/bond store. SRP authenticates independent bootstrap/manager proofs.
    if ((err = protocomm_ble_start(pc_, &config)) != ESP_OK) { protocomm_delete(pc_); pc_ = nullptr; return err; }
    if ((err = protocomm_set_security(pc_, "prov-session", &protocomm_security2, &security)) == ESP_OK)
        err = protocomm_set_version(pc_, "proto-ver", "{\"prov\":{\"ver\":\"v1.0\",\"sec_ver\":2,\"sec_patch_ver\":1,\"cap\":[]}}");
    if (err == ESP_OK) err = protocomm_add_endpoint(pc_, "cube-control", Control, this);
    ble_active_ = err == ESP_OK;
    return err;
}

esp_err_t CubeHardware::Control(uint32_t, const uint8_t* in, ssize_t len, uint8_t** out, ssize_t* outlen, void* context) {
    auto* self = static_cast<CubeHardware*>(context);
    std::string reply = len > 0 && len <= 496 ? self->Command(in, len) : failure("invalid-request");
    if (reply.empty() || reply.size() > 2048) return ESP_ERR_NO_MEM;
    *out = static_cast<uint8_t*>(malloc(reply.size()));
    if (!*out) return ESP_ERR_NO_MEM;
    memcpy(*out, reply.data(), reply.size()); *outlen = reply.size();
    return ESP_OK;
}
std::string CubeHardware::Command(const uint8_t* data, size_t len) {
    // cJSON strings cannot represent embedded NUL. Reject its JSON escape too;
    // otherwise validation could authorize a truncated field not what phone sent.
    std::string input(reinterpret_cast<const char*>(data), len);
    if (!cube_flat_object(input) || input.find('\0') != std::string::npos ||
        input.find("\\u0000") != std::string::npos) return failure("invalid-request");
    const char* end = nullptr;
    Json root(cJSON_ParseWithLengthOpts(input.c_str(), input.size() + 1, &end, true), cJSON_Delete);
    if (!root || number(root.get(), "version") != 1) return failure("invalid-request");
    const auto op = text(root.get(), "op");
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return failure("busy");
    if (fatal_) return failure("storage");
    // Once install commits, no existing bootstrap session retains any authority.
    if (ble_bootstrap_ != (record_.phase == EnrollmentPhase::Bootstrap)) return failure("denied");
    auto reply = object();
    cJSON_AddNumberToObject(reply.get(), "version", 1);
    cJSON_AddBoolToObject(reply.get(), "ok", true);
    if (op == "status") {
        if (!fields(root.get(), {"version", "op"})) return failure("invalid-request");
        cJSON_AddStringToObject(reply.get(), "deviceId", record_.device_id);
        cJSON_AddStringToObject(reply.get(), "attemptId", record_.attempt_id);
        cJSON_AddNumberToObject(reply.get(), "generation", record_.generation);
        cJSON_AddStringToObject(reply.get(), "phase", phase(record_.phase));
        wifi_ap_record_t ap{};
        bool joined = !apply_wifi_ && wifi_connected_ && esp_wifi_sta_get_ap_info(&ap) == ESP_OK &&
            memcmp(ap.ssid, wifi_config_.sta.ssid, sizeof(wifi_config_.sta.ssid)) == 0;
        cJSON_AddBoolToObject(reply.get(), "wifiConnected", joined);
        const auto state = wifi_state_.load();
        cJSON_AddStringToObject(reply.get(), "wifiState", joined ? "connected" :
            state == WifiState::Failed ? "failed" : state == WifiState::Offline ? "offline" : "joining");
        std::string ssid(reinterpret_cast<char*>(wifi_config_.sta.ssid), strnlen(reinterpret_cast<char*>(wifi_config_.sta.ssid), 32));
        cJSON_AddStringToObject(reply.get(), "ssid", ssid.c_str());
        cJSON_AddBoolToObject(reply.get(), "gatewayConnected", joined && gateway_ready_);
        cJSON_AddBoolToObject(reply.get(), "accountAttention", account_attention_);
        cJSON_AddStringToObject(reply.get(), "lastError", last_error_.c_str());
        cJSON_AddStringToObject(reply.get(), "firmware", esp_app_get_description()->version);
        if (battery_ < 0) cJSON_AddNullToObject(reply.get(), "batteryPercent");
        else cJSON_AddNumberToObject(reply.get(), "batteryPercent", battery_);
        cJSON_AddBoolToObject(reply.get(), "charging", charging_);
    } else if (op == "install" || op == "enroll") {
        bool install = op == "install";
        if (install != ble_bootstrap_) return failure("denied");
        if (install ? !fields(root.get(), {"version","op","deviceId","attemptId","generation","enrollmentSecret","managerSecret","gatewayOrigin","gatewayWsPath"})
                    : !fields(root.get(), {"version","op","deviceId","attemptId","generation","enrollmentSecret","gatewayOrigin","gatewayWsPath"}))
            return failure("invalid-request");
        auto id = text(root.get(), "deviceId"), attempt = text(root.get(), "attemptId");
        auto proof = text(root.get(), "enrollmentSecret"), manager = text(root.get(), "managerSecret");
        auto origin = text(root.get(), "gatewayOrigin"), path = text(root.get(), "gatewayWsPath");
        uint32_t gen = number(root.get(), "generation");
        if (id != record_.device_id || !record_.can_enroll(attempt, gen, proof, origin, path)) return failure("conflict");
        if (install && (!cube_secret(manager) || manager == proof || manager == record_.bootstrap || proof == record_.bootstrap)) return failure("invalid-request");
        if (!record_.same_attempt(attempt, gen, proof)) {
            auto next = record_;
            if (install && verifier("cube-manager", manager, next.salt, next.verifier) != ESP_OK) return failure("storage");
            next.phase = EnrollmentPhase::Pending;
            next.generation = gen;
            cube_copy(next.attempt_id, attempt); cube_copy(next.enrollment, proof);
            cube_copy(next.renewal, secret());
            cube_copy(next.origin, origin); cube_copy(next.ws_path, path);
            memset(next.bootstrap, 0, sizeof(next.bootstrap));
            if (Save(next) != ESP_OK) return failure("storage");
            token_.clear(); ++revision_; qr_.clear();
        }
        account_attention_ = false; last_error_.clear(); sync_requested_ = true; sync_attempts_ = 0; next_sync_ = 0;
        cJSON_AddStringToObject(reply.get(), "attemptId", record_.attempt_id);
        cJSON_AddNumberToObject(reply.get(), "generation", record_.generation);
        cJSON_AddBoolToObject(reply.get(), "reconnect", install);
        if (install) ble_restart_ = true;
    } else if (op == "wifi.set" || op == "wifi.clear") {
        if (ble_bootstrap_) return failure("denied");
        bool set = op == "wifi.set";
        if (set ? !fields(root.get(), {"version","op","ssid","password"}) : !fields(root.get(), {"version","op"})) return failure("invalid-request");
        auto ssid = text(root.get(), "ssid"), password = text(root.get(), "password");
        if (set && (!cJSON_IsString(cJSON_GetObjectItemCaseSensitive(root.get(), "password")) || !cube_wifi(ssid, password))) return failure("invalid-request");
        WifiRecord wifi;
        cube_copy(wifi.ssid, ssid); cube_copy(wifi.password, password);
        auto err = set ? nvs_set_blob(wifi_nvs_, "network", &wifi, sizeof(wifi)) : nvs_erase_key(wifi_nvs_, "network");
        if (err == ESP_ERR_NVS_NOT_FOUND && !set) err = ESP_OK;
        if (err == ESP_OK) err = nvs_commit(wifi_nvs_);
        if (err != ESP_OK) return failure("storage");
        wifi_config_ = {};
        memcpy(wifi_config_.sta.ssid, ssid.data(), ssid.size());
        memcpy(wifi_config_.sta.password, password.data(), password.size());
        have_wifi_ = set; apply_wifi_ = true; wifi_connected_ = false; gateway_ready_ = false;
        wifi_state_ = set ? WifiState::Joining : WifiState::Offline;
    } else if (op == "retry") {
        if (ble_bootstrap_) return failure("denied");
        if (!fields(root.get(), {"version","op"})) return failure("invalid-request");
        account_attention_ = false; sync_requested_ = true; sync_attempts_ = 0; next_sync_ = 0;
        apply_wifi_ = true;
    } else return failure("invalid-request");
    return encode(reply.get());
}

void CubeHardware::SyncGateway() {
    CubeEnrollment saved;
    uint32_t epoch;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        saved = record_; epoch = epoch_; syncing_ = true;
    }
    const char* route = saved.phase == EnrollmentPhase::Pending ? "redeem" :
                        saved.phase == EnrollmentPhase::Committed ? "activate" : "renew";
    auto response = request(saved, route);
    Json root(cube_flat_object(response.body) ?
        cJSON_ParseWithLengthOpts(response.body.c_str(), response.body.size() + 1, nullptr, true) : nullptr, cJSON_Delete);
    std::lock_guard<std::mutex> lock(mutex_);
    syncing_ = false;
    if (epoch != epoch_ || fatal_) return; // New manager intent fences late HTTP completion.
    http_ = response.diagnostic;
    if (response.status == 200 && !root) http_.phase = "response-json";
    bool matches = root && number(root.get(), "version") == 1 &&
        text(root.get(), "deviceId") == saved.device_id && text(root.get(), "attemptId") == saved.attempt_id &&
        number(root.get(), "generation") == saved.generation && text(root.get(), "deviceClass") == "cube";
    std::string status = text(root.get(), "status"), token = text(root.get(), "token");
    if (response.status == 200 && matches &&
        ((saved.phase == EnrollmentPhase::Pending && (status == "committed" || status == "active")) ||
         (saved.phase != EnrollmentPhase::Pending && status == "active" && token.size() >= 16 && token.size() <= 2048))) {
        auto next = saved;
        if (saved.phase == EnrollmentPhase::Pending) {
            next.phase = EnrollmentPhase::Committed;
            next.confirmed_generation = next.generation;
            if (Save(next) != ESP_OK) return;
            sync_requested_ = true; next_sync_ = 0; // Bootstrap was already durably retired before redeem.
        } else {
            if (saved.phase != EnrollmentPhase::Active) {
                next.phase = EnrollmentPhase::Active;
                if (Save(next) != ESP_OK) return;
            }
            token_ = std::move(token); ++revision_;
            sync_requested_ = true;
            next_sync_ = esp_timer_get_time() + CONFIG_CUBE_RENEW_INTERVAL_SECONDS * 1000000ULL;
        }
        account_attention_ = false; last_error_.clear(); sync_attempts_ = 0;
        return;
    }
    if (response.status == 200 && root) http_.phase = "response-contract";
    last_error_ = response.status == 403 || response.status == 401 ? "denied" :
                  response.status == 410 ? "expired" : response.status == 409 ? "conflict" : "unavailable";
    bool retryable = response.status == 0 || response.status == 408 || response.status == 429 ||
                     (response.status == 503 && text(root.get(), "error") != "escrow-unavailable");
    if (!retryable) {
        account_attention_ = true; token_.clear(); ++revision_; sync_requested_ = false;
    } else if (++sync_attempts_ >= 5) {
        sync_requested_ = false;
    } else {
        unsigned delay = std::max(response.retry_after, std::min(1u << sync_attempts_, 30u));
        next_sync_ = esp_timer_get_time() + delay * 1000000ULL;
    }
}

void CubeHardware::Run() {
    auto err = StartBle();
    if (err != ESP_OK) { std::lock_guard<std::mutex> lock(mutex_); fatal_ = true; last_error_ = "ble-unavailable"; }
    unsigned wifi_attempts = 0;
    int64_t next_wifi = 0;
    for (;;) {
        int handle = ble_handle_.load();
        int64_t deadline = ble_deadline_.load();
        if (handle >= 0 && deadline > 0 && esp_timer_get_time() >= deadline) {
            ble_deadline_ = 0;
            ble_gap_terminate(handle, BLE_ERR_REM_USER_CONN_TERM);
        }
        if (ble_restart_.exchange(false)) {
            // Stop joins NimBLE host task before deleting Security2 state. A lost
            // install response is harmless: pending record already requires manager.
            if (!pc_ || protocomm_ble_stop(pc_) != ESP_OK) abort();
            ble_active_ = false; ble_authenticated_ = false; ble_handle_ = -1; ble_deadline_ = 0;
            protocomm_delete(pc_); pc_ = nullptr;
            if (StartBle() != ESP_OK) { std::lock_guard<std::mutex> lock(mutex_); fatal_ = true; last_error_ = "ble-unavailable"; }
        }
        wifi_config_t wifi{};
        bool apply, have, sync;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            apply = apply_wifi_; apply_wifi_ = false; have = have_wifi_; wifi = wifi_config_;
            sync = !fatal_ && !account_attention_ && sync_requested_ && record_.phase != EnrollmentPhase::Bootstrap &&
                   wifi_connected_ && esp_timer_get_time() >= next_sync_;
        }
        if (apply) {
            esp_wifi_disconnect();
            // Empty configuration prevents retained driver credentials surviving clear.
            auto configured = esp_wifi_set_config(WIFI_IF_STA, &wifi);
            wifi_attempts = configured == ESP_OK ? 0 : 5;
            wifi_state_ = !have ? WifiState::Offline : configured == ESP_OK ? WifiState::Joining : WifiState::Failed;
            next_wifi = 0;
        }
        if (wifi_connected_) wifi_attempts = 0;
        else if (have && wifi_attempts < 5 && esp_timer_get_time() >= next_wifi) {
            esp_wifi_connect();
            wifi_state_ = WifiState::Joining;
            next_wifi = esp_timer_get_time() + (1u << ++wifi_attempts) * 1000000ULL;
        } else if (!wifi_connected_ && have && wifi_attempts >= 5 && esp_timer_get_time() >= next_wifi) {
            wifi_state_ = WifiState::Failed;
        }
        if (sync) {
            // TLS certificate validity requires network time; never disable verification.
            if (time(nullptr) > 1704067200) SyncGateway();
            else { std::lock_guard<std::mutex> lock(mutex_); last_error_ = "clock-unavailable"; }
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
} // namespace sentient::cube
