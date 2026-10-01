"""Execute production gateway transition boundary with deterministic HTTP failures."""
from pathlib import Path
import os
import subprocess
import pytest

BOARD = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube'


def function(source, signature):
    start = source.index(signature)
    brace = source.index('{', start)
    # Selected functions have balanced braces, including JSON-free string literals.
    depth = 0
    for i in range(brace, len(source)):
        depth += (source[i] == '{') - (source[i] == '}')
        if depth == 0:
            return source[start:i + 1]
    raise AssertionError(signature)


def test_gateway_commit_renewal_and_late_response_fence(tmp_path):
    idf = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf'))
    cjson = idf / 'components/json/cJSON'
    if not (cjson / 'cJSON.c').exists():
        pytest.skip('ESP-IDF cJSON source needed for host adapter check')
    source = (BOARD / 'cube_hardware.cc').read_text()
    methods = '\n'.join(function(source, signature) for signature in (
        'std::string text(', 'std::string encode(', 'Json object()', 'bool fields(',
        'uint32_t number(', 'const char* phase(', 'std::string failure(',
        'CubeHardwareStatus CubeHardware::Status()',
        'std::string CubeHardware::Command(', 'void CubeHardware::SyncGateway()'))
    program = r'''
#include "cube_enrollment.h"
#include "cube_http_diagnostics.h"
#include <cJSON.h>
#include <cassert>
#include <atomic>
#include <set>
#include <cmath>
#include <functional>
#include <memory>
#include <mutex>
#include <vector>
using namespace sentient::cube;
using Json=std::unique_ptr<cJSON,decltype(&cJSON_Delete)>;
constexpr int ESP_OK=0, CONFIG_CUBE_RENEW_INTERVAL_SECONDS=3600;
int64_t clock_us=100;
int64_t esp_timer_get_time() { return clock_us; }
struct HttpResult { std::string body; int status=0; unsigned retry_after=0; bool overflow=false; CubeHttpDiagnostics diagnostic{}; };
HttpResult next_http;
std::vector<std::string> routes, proofs;
std::function<void()> during_request;
HttpResult request(const CubeEnrollment& r,const char* route) {
    routes.emplace_back(route); proofs.emplace_back(r.renewal);
    assert(r.valid());
    if(during_request) during_request();
    return next_http;
}
struct CubeHardwareStatus {
    const char* phase;
    std::string last_error;
    bool fatal, account_attention, ble_active, ble_connected, ble_authenticated;
    bool wifi_connected, gateway_ready;
    const char* wifi_state;
    CubeHttpDiagnostics http;
    const char* ws_start_phase;
    int ws_start_error;
};
struct WifiRecord { char ssid[33]{}; char password[65]{}; };
struct wifi_config_t { struct { uint8_t ssid[32],password[64]; } sta{}; };
struct wifi_ap_record_t { uint8_t ssid[33]{}; };
int esp_wifi_sta_get_ap_info(wifi_ap_record_t*) { return 1; }
struct app_desc { const char* version="test"; };
const app_desc* esp_app_get_description() { static app_desc value; return &value; }
int network_writes=0;
constexpr int ESP_ERR_NVS_NOT_FOUND=2;
int nvs_set_blob(int,const char*,const void*,size_t) { ++network_writes; return 0; }
int nvs_erase_key(int,const char*) { ++network_writes; return 0; }
int nvs_commit(int) { return 0; }
std::string secret() { return std::string(42,'D')+'A'; }
int verifier(const char*,const std::string&,uint8_t* salt,uint8_t* v) {
    memset(salt,1,32); memset(v,2,384); return 0;
}
class CubeHardware {
public:
    bool ble_bootstrap_=false, apply_wifi_=false, wifi_connected_=false, gateway_ready_=false;
    bool have_wifi_=false, ble_restart_=false, charging_=false;
    std::atomic<bool> ble_active_{false}, ble_authenticated_{false};
    std::atomic<int> ble_handle_{-1};
    int wifi_nvs_=1, battery_=-1;
    std::string qr_;
    wifi_config_t wifi_config_;
    enum class WifiState { Offline, Joining, Connected, Failed };
    std::atomic<WifiState> wifi_state_{WifiState::Offline};
    std::string Command(const uint8_t*,size_t);
    CubeHardwareStatus Status();
    std::mutex mutex_;
    CubeEnrollment record_;
    uint32_t epoch_=0, revision_=0;
    bool syncing_=false, fatal_=false, account_attention_=false, sync_requested_=true;
    unsigned sync_attempts_=0;
    int64_t next_sync_=0;
    std::string token_,last_error_;
    CubeHttpDiagnostics http_;
    const char* ws_start_phase_="idle";
    int ws_start_error_=0;
    bool storage_fails=false;
    std::vector<EnrollmentPhase> durable;
    int Save(const CubeEnrollment& r) {
        if(storage_fails) { fatal_=true; token_.clear(); return 1; }
        assert(r.valid()); record_=r; ++epoch_; durable.push_back(r.phase); return ESP_OK;
    }
    void SyncGateway();
};
''' + methods + r'''
std::string response(const CubeEnrollment& r,const char* status,bool token=false) {
    return "{\"version\":1,\"deviceClass\":\"cube\",\"deviceId\":\""+cube_text(r.device_id)+
        "\",\"attemptId\":\""+cube_text(r.attempt_id)+"\",\"generation\":"+std::to_string(r.generation)+
        ",\"status\":\""+status+"\""+(token ? ",\"token\":\"opaque-device-token-test\"" : "")+"}";
}
void initialize(CubeHardware& h) {
    h.record_.phase=EnrollmentPhase::Pending; h.record_.generation=1;
    cube_copy(h.record_.device_id,"12345678-1234-4234-8234-123456789abc");
    cube_copy(h.record_.attempt_id,"22345678-1234-4234-8234-123456789abc");
    cube_copy(h.record_.enrollment,std::string(43,'A')); cube_copy(h.record_.renewal,std::string(43,'A'));
    cube_copy(h.record_.origin,"https://gateway.test"); cube_copy(h.record_.ws_path,"/ws");
    memset(h.record_.salt,1,32); memset(h.record_.verifier,2,384);
    assert(h.record_.valid());
}
std::string command(CubeHardware& h,const std::string& json) {
    return h.Command(reinterpret_cast<const uint8_t*>(json.data()),json.size());
}
int main() {
    CubeHardware boot; boot.ble_bootstrap_=true;
    cube_copy(boot.record_.device_id,"12345678-1234-4234-8234-123456789abc");
    cube_copy(boot.record_.bootstrap,std::string(43,'A'));
    boot.qr_="private-qr";
    boot.ble_active_=true; boot.ble_handle_=1; boot.ble_authenticated_=true;
    auto diagnostic=boot.Status();
    assert(std::string(diagnostic.phase)=="bootstrap" && diagnostic.ble_active &&
           diagnostic.ble_connected && diagnostic.ble_authenticated &&
           diagnostic.wifi_state==std::string("offline") && !diagnostic.wifi_connected &&
           diagnostic.last_error.find("private-qr")==std::string::npos);
    for(auto op : {"wifi.clear","retry","enroll"}) {
        assert(command(boot,"{\"version\":1,\"op\":\""+std::string(op)+"\"}").find("denied")!=std::string::npos);
    }
    assert(network_writes==0 && boot.durable.empty());
    for(auto bad : {R"({"version":1,"op":"status","op":"status"})", R"({"version":1,"op":"status","extra":1})",
                    R"({"version":1,"op":"status","extra":{"nested":1}})", R"({"version":1,"op":"status\u0000"})"}) {
        assert(command(boot,bad).find("invalid-request")!=std::string::npos);
    }
    std::string install=R"({"version":1,"op":"install","deviceId":"12345678-1234-4234-8234-123456789abc","attemptId":"22345678-1234-4234-8234-123456789abc","generation":1,"enrollmentSecret":")"+
        std::string(42,'B')+R"(A","managerSecret":")"+std::string(42,'C')+R"(A","gatewayOrigin":"https://gateway.test","gatewayWsPath":"/ws"})";
    assert(command(boot,install).find("\"ok\":true")!=std::string::npos);
    assert(boot.record_.phase==EnrollmentPhase::Pending && boot.record_.bootstrap[0]==0 && boot.ble_restart_);
    diagnostic=boot.Status();
    assert(std::string(diagnostic.phase)=="pending" && diagnostic.last_error.empty());
    // Lost install reply never leaves original authenticated bootstrap session usable.
    assert(command(boot,R"({"version":1,"op":"status"})").find("denied")!=std::string::npos);
    assert(command(boot,install).find("denied")!=std::string::npos);
    boot.ble_bootstrap_=false; // New Security2 session, independently authenticated manager.
    assert(command(boot,install).find("denied")!=std::string::npos);
    auto status=command(boot,R"({"version":1,"op":"status"})");
    assert(status.find("\"ok\":true")!=std::string::npos && status.find(boot.record_.renewal)==std::string::npos);
    assert(command(boot,R"({"version":1,"op":"wifi.set","ssid":"home","password":"password"})").find("\"ok\":true")!=std::string::npos);
    assert(network_writes==1 && boot.have_wifi_ && !boot.wifi_connected_ && !boot.gateway_ready_);
    assert(command(boot,R"({"version":1,"op":"wifi.clear"})").find("\"ok\":true")!=std::string::npos);
    assert(!boot.have_wifi_ && boot.record_.phase==EnrollmentPhase::Pending && boot.record_.verifier[0]==2);
    CubeHardware h; initialize(h);
    next_http={"",0}; h.SyncGateway(); // Redeem succeeded remotely, response lost.
    assert(h.record_.phase==EnrollmentPhase::Pending && h.token_.empty() && h.sync_requested_);
    next_http={response(h.record_,"committed"),200}; h.SyncGateway();
    assert(routes[0]=="redeem" && routes[1]=="redeem" && proofs[0]==proofs[1]);
    assert(h.record_.phase==EnrollmentPhase::Committed && h.record_.bootstrap[0]==0 && h.token_.empty());
    assert(h.durable.back()==EnrollmentPhase::Committed);
    next_http={"",0}; h.SyncGateway(); // Lost activation reply must repeat activation, never re-enroll.
    assert(routes.back()=="activate" && h.record_.phase==EnrollmentPhase::Committed);
    next_http={response(h.record_,"active",true),200}; h.SyncGateway();
    assert(routes.back()=="activate" && h.record_.phase==EnrollmentPhase::Active && !h.token_.empty());
    next_http={response(h.record_,"active",true),200};
    auto short_token=next_http.body.find("opaque-device-token-test");
    next_http.body.replace(short_token,strlen("opaque-device-token-test"),1200,'x');
    h.SyncGateway();
    assert(h.token_.size()==1200 && !h.account_attention_);
    h.SyncGateway(); assert(routes.back()=="renew" && h.durable.size()==2); // Tokens never saved to NVS.
    next_http={"{\"error\":\"denied\",\"retryable\":false}",403}; h.SyncGateway();
    assert(h.account_attention_ && h.token_.empty() && !h.sync_requested_);
    assert(h.record_.phase==EnrollmentPhase::Active && h.record_.verifier[0]==2);

    CubeHardware limited; initialize(limited); next_http={"",0};
    for(int i=0;i<5;++i) limited.SyncGateway();
    assert(!limited.sync_requested_ && limited.sync_attempts_==5);
    CubeHardware rate; initialize(rate); next_http={"{}",429,60}; rate.SyncGateway();
    assert(rate.next_sync_>=clock_us+60000000 && rate.sync_requested_);
    CubeHardware expired; initialize(expired); next_http={"{}",410}; expired.SyncGateway();
    assert(expired.account_attention_ && !expired.sync_requested_);
    CubeHardware malformed; initialize(malformed); next_http={"{}",200}; malformed.SyncGateway();
    assert(malformed.account_attention_ && malformed.token_.empty());
    assert(std::string(malformed.Status().http.phase)=="response-contract");
    CubeHardware nested; initialize(nested); next_http={"{\"nested\":{}}",200}; nested.SyncGateway();
    assert(std::string(nested.Status().http.phase)=="response-json" && nested.token_.empty());

    CubeHardware stale; initialize(stale); next_http={response(stale.record_,"committed"),200};
    during_request=[&] { ++stale.epoch_; stale.record_.generation=2;
        cube_copy(stale.record_.attempt_id,"32345678-1234-4234-8234-123456789abc"); };
    stale.SyncGateway(); during_request={};
    assert(stale.record_.generation==2 && stale.record_.phase==EnrollmentPhase::Pending && stale.durable.empty());
    CubeHardware failed; initialize(failed); failed.storage_fails=true;
    next_http={response(failed.record_,"committed"),200}; failed.SyncGateway();
    assert(failed.fatal_ && failed.token_.empty() && failed.record_.phase==EnrollmentPhase::Pending);
}
'''
    (tmp_path / 'main.cc').write_text(program)
    subprocess.run(['cc', '-c', str(cjson / 'cJSON.c'), '-I', str(cjson),
                    '-o', str(tmp_path / 'json.o')], check=True)
    binary = tmp_path / 'check'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pthread',
                    '-I', str(BOARD), '-I', str(cjson), str(tmp_path / 'main.cc'),
                    str(tmp_path / 'json.o'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
