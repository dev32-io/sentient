"""Execute production task-start boundaries with constrained internal heap."""
from pathlib import Path
import subprocess
from test_cube_gateway_lifecycle import function

MAIN = Path(__file__).resolve().parents[2] / 'firmware/main'


def test_ws_start_reports_allocation_failures_without_leaking_semaphore(tmp_path):
    method = function((MAIN / 'protocols/sentient_ws_protocol.cc').read_text(),
                      'esp_err_t SentientWsProtocol::connect()')
    source = r'''
#include <cassert>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
using esp_err_t=int;
constexpr int ESP_OK=0, ESP_FAIL=-1, ESP_ERR_INVALID_STATE=259, ESP_ERR_INVALID_ARG=258,
              ESP_ERR_NO_MEM=257, pdPASS=1, WEBSOCKET_EVENT_ANY=0;
#define ESP_LOGE(...)
int largest_internal=7680, semaphores=0, clients=0, starts=0;
int fail_stage=0;
constexpr int MALLOC_CAP_SPIRAM=1, MALLOC_CAP_8BIT=2;
int semaphore;
void* xSemaphoreCreateBinary() { if(fail_stage==1)return nullptr; ++semaphores;return &semaphore; }
void vSemaphoreDelete(void*) { assert(semaphores==1);--semaphores; }
int xTaskCreate(void(*)(void*),const char*,int bytes,void*,int,void** task) {
    assert(bytes==8192);
    if(bytes>largest_internal)return 0;
    *task=(void*)1;return pdPASS;
}
int xTaskCreateWithCaps(void(*)(void*),const char*,int bytes,void*,int,void** task,int caps) {
    assert(bytes==8192 && caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    if(fail_stage==5)return 0; // Actual task allocator failure, not a guessed threshold.
    *task=(void*)1;return pdPASS;
}
int esp_crt_bundle_attach(void*) {return 0;}
struct esp_websocket_client_config_t {
    const char* uri=nullptr; bool disable_auto_reconnect=false;
    int buffer_size=0,task_stack=0,network_timeout_ms=0;
    const char* cert_pem=nullptr; int(*crt_bundle_attach)(void*)=nullptr;
};
void* esp_websocket_client_init(const esp_websocket_client_config_t* cfg) {
    assert(cfg->cert_pem || cfg->crt_bundle_attach);
    if(fail_stage==2)return nullptr;
    ++clients;return (void*)2;
}
int esp_websocket_register_events(void*,int,void(*)(void*,int,int,void*),void*) {return fail_stage==3 ? ESP_FAIL : ESP_OK;}
int esp_websocket_client_start(void*) {++starts;return fail_stage==4 ? ESP_FAIL : ESP_OK;}
void esp_websocket_client_destroy(void*) {assert(clients==1);--clients;}
enum class SdkStatus { Connecting, Reconnecting, Error };
struct SentientWsProtocol {
    struct Config {
        std::string gateway_url="wss://disposable.test/ws",device_id="disposable";
        const char* cert_pem=nullptr;
        std::function<void(const char*,int)> on_start_result;
    } cfg_;
    void* client_=nullptr; void* worker_=nullptr; void* worker_done_=nullptr;
    std::mutex state_mutex_;
    struct {bool terminal_auth=false;} wire_;
    bool stopping_=false;
    int reconnect_attempts_=0,retries=0;
    SdkStatus state=SdkStatus::Connecting;
    static void worker_entry(void*) {}
    static void ws_event_handler(void*,int,int,void*) {}
    void set_status(SdkStatus s) {state=s;}
    void schedule_reconnect() {++retries;}
    esp_err_t connect();
};
''' + method + r'''
int main() {
    SentientWsProtocol ws;
    std::string phase; int error=0,reports=0;
    ws.cfg_.on_start_result=[&](const char* p,int e){phase=p;error=e;++reports;};
    // Internal budget cannot fit an 8 KiB stack; caps path must still work.
    void* task=nullptr;
    assert(!xTaskCreate(nullptr,"probe",8192,nullptr,4,&task));
    fail_stage=5;
    assert(ws.connect()==ESP_ERR_NO_MEM);
    assert(phase=="worker-task" && error==ESP_ERR_NO_MEM && reports==1);
    assert(!ws.worker_ && !ws.worker_done_ && !semaphores && !clients && !starts);
    fail_stage=1;
    assert(ws.connect()==ESP_ERR_NO_MEM && phase=="worker-sync" && !semaphores);
    assert(largest_internal==7680); // No imaginary heap increase to make WS start pass.
    for(int stage=2;stage<=4;++stage) {
        fail_stage=stage;
        assert(ws.connect()==ESP_FAIL && error==ESP_FAIL);
        assert(phase==(stage==2 ? "client-init" : stage==3 ? "client-events" : "client-start"));
        assert(ws.worker_ && semaphores==1 && clients==0 && ws.state==SdkStatus::Error);
    }
    fail_stage=0;
    assert(ws.connect()==ESP_OK && phase=="started" && !error && clients==1 && semaphores==1);
    assert(ws.connect()==ESP_ERR_INVALID_STATE && phase=="state" && clients==1);
    esp_websocket_client_destroy(ws.client_);vSemaphoreDelete(ws.worker_done_);
    assert(!semaphores && !clients);
}
'''
    (tmp_path / 'start.cc').write_text(source)
    binary = tmp_path / 'start'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsanitize=address',
                    '-DCONFIG_BOARD_TYPE_SENTIENT_CUBE=1',
                    str(tmp_path / 'start.cc'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def test_codec_task_uses_external_stack_and_matching_delete(tmp_path):
    method = function((MAIN / 'audio/audio_service.cc').read_text(), 'void AudioService::Start()')
    source = r'''
#include <cassert>
#include <cstdlib>
#include <cstring>
#define ESP_LOGE(...)
constexpr int pdPASS=1,MALLOC_CAP_SPIRAM=1,MALLOC_CAP_8BIT=2;
constexpr int AS_EVENT_AUDIO_TESTING_RUNNING=1,AS_EVENT_WAKE_WORD_RUNNING=2,AS_EVENT_AUDIO_PROCESSOR_RUNNING=4;
using Entry=void(*)(void*);
Entry codec_entry=nullptr;void* codec_arg=nullptr;
int external_bytes=0,internal_codec_bytes=0,deleted_caps=0,deleted_plain=0;
void xEventGroupClearBits(int,int) {}
void esp_timer_start_periodic(int,int) {}
void vTaskDelete(void*) {++deleted_plain;}
void vTaskDeleteWithCaps(void*) {++deleted_caps;}
int xTaskCreate(Entry fn,const char* name,int bytes,void* arg,int,void**) {
    if(!strcmp(name,"opus_codec")) {internal_codec_bytes=bytes;codec_entry=fn;codec_arg=arg;}
    return pdPASS;
}
int xTaskCreateWithCaps(Entry fn,const char* name,int bytes,void* arg,int,void**,int caps) {
    assert(!strcmp(name,"opus_codec") && caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    external_bytes=bytes;codec_entry=fn;codec_arg=arg;return pdPASS;
}
struct AudioService {
    bool service_stopped_=true;int event_group_=0,audio_power_timer_=0;
    void* audio_input_task_handle_=nullptr;void* audio_output_task_handle_=nullptr;void* opus_codec_task_handle_=nullptr;
    int codec_runs=0;
    void AudioInputTask() {} void AudioOutputTask() {} void OpusCodecTask() {++codec_runs;}
    void Start();
};
''' + method + r'''
int main() {
    AudioService service;service.Start();
    assert(codec_entry && codec_arg==&service);
    codec_entry(codec_arg);
    assert(service.codec_runs==1);
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    assert(external_bytes==24576 && !internal_codec_bytes && deleted_caps==1 && !deleted_plain);
#else
    assert(internal_codec_bytes==24576 && !external_bytes && deleted_plain==1 && !deleted_caps);
#endif
}
'''
    (tmp_path / 'codec.cc').write_text(source)
    for cube in (0, 1):
        binary = tmp_path / f'codec{cube}'
        subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        f'-DCONFIG_BOARD_TYPE_SENTIENT_CUBE={cube}', str(tmp_path / 'codec.cc'),
                        '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


def test_sdk_transport_task_caps_and_actual_allocation_error(tmp_path):
    import sys
    component = MAIN.parent / 'managed_components/espressif__esp_websocket_client'
    patched = tmp_path / 'esp_websocket_client.c'
    subprocess.run([sys.executable, str(MAIN.parent / 'scripts/patch_websocket_stack.py'),
                    str(component / 'esp_websocket_client.c'), str(patched)], check=True)
    method = function(patched.read_text(), 'esp_err_t esp_websocket_client_start(')
    program = r'''
#include <cassert>
#include <cstddef>
#define ESP_LOGE(...)
#define ESP_LOGI(...)
using esp_err_t=int;
constexpr int ESP_OK=0, ESP_FAIL=-1, ESP_ERR_INVALID_ARG=258, ESP_ERR_NO_MEM=257,
    WEBSOCKET_STATE_INIT=1, STOPPED_BIT=1, CLOSE_FRAME_SENT_BIT=2, REQUESTED_STOP_BIT=4,
    WAKEUP_BIT=8, MALLOC_CAP_SPIRAM=1, MALLOC_CAP_8BIT=2, pdTRUE=1;
struct Config { void* ext_transport=nullptr; const char* task_name=nullptr;
    int task_stack=8192,task_prio=5,task_core_id=-1; };
struct Client { Config* config; int state=0; void* transport=nullptr; int status_bits=1;
    void* task_handle=nullptr; };
using esp_websocket_client_handle_t=Client*;
int bits=STOPPED_BIT,creates=0;
bool task_allocation_fails=true;
void xEventGroupClearBits(int,int flags) {bits &= ~flags;}
void xEventGroupSetBits(int,int flags) {bits |= flags;}
void esp_websocket_client_task(void*) {}
int esp_websocket_client_create_transport(Client* c) {c->transport=(void*)1;return ESP_OK;}
int xTaskCreatePinnedToCoreWithCaps(void(*fn)(void*),const char*,int bytes,void* arg,int prio,
                                  void** handle,int core,int caps) {
    assert(fn==esp_websocket_client_task && arg && bytes==8192 && prio==5 && core==-1);
    assert(caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    ++creates;
    if(task_allocation_fails)return 0;
    *handle=(void*)2;return pdTRUE;
}
''' + method + r'''
int main() {
    Config cfg;Client client{&cfg};
    assert(esp_websocket_client_start(nullptr)==ESP_ERR_INVALID_ARG);
    assert(esp_websocket_client_start(&client)==ESP_ERR_NO_MEM);
    assert(!client.task_handle && bits==STOPPED_BIT && creates==1);
    task_allocation_fails=false;
    assert(esp_websocket_client_start(&client)==ESP_OK);
    assert(client.task_handle && !(bits & STOPPED_BIT) && creates==2);
}
'''
    (tmp_path / 'sdk_start.cc').write_text(program)
    binary = tmp_path / 'sdk_start'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsanitize=address',
                    str(tmp_path / 'sdk_start.cc'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
