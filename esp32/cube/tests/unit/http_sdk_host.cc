// Only TLS/socket and RTOS clock are scripted. HTTP parsing, buffering, reads,
// transport dispatch/ownership, and Cube's adapter are the production sources.
#include "cube_http.h"
#include <cassert>
#include <vector>
#include <esp_transport_tcp.h>
using namespace sentient::cube;
static int64_t now;
static std::string response;
static size_t offset, quantum;
static int delay_ms, reads, closes, live;
static bool verified;
static bool partial_record, connect_failure;
extern "C" int64_t esp_timer_get_time() { return now; }
extern "C" void vTaskDelay(int ms) { now += ms*1000; }
static int dns_mode, semaphores;
static dns_found_callback pending_dns;
static void* pending_context;
extern "C" SemaphoreHandle_t xSemaphoreCreateBinary() {++semaphores;return new int(0);}
extern "C" void vSemaphoreDelete(SemaphoreHandle_t s) {--semaphores;delete s;}
extern "C" int xSemaphoreGive(SemaphoreHandle_t s) {*s=1;return 1;}
extern "C" int xSemaphoreTake(SemaphoreHandle_t s,int ticks) {if(*s)return 1;now+=int64_t(ticks)*1000;return 0;}
extern "C" int ipaddr_aton(const char* s,ip_addr_t* ip) {
    if(strcmp(s,"127.0.0.1"))return 0;strcpy(ip->text,s);return 1;
}
extern "C" char* ipaddr_ntoa_r(const ip_addr_t* ip,char* out,int n) {assert(n>10);strcpy(out,ip->text);return out;}
extern "C" int tcpip_try_callback(void(*fn)(void*),void* p) {if(dns_mode==2)return -1;fn(p);return 0;}
extern "C" int dns_gethostbyname(const char*,ip_addr_t* out,dns_found_callback cb,void* context) {
    if(dns_mode==1){pending_dns=cb;pending_context=context;return ERR_INPROGRESS;}
    strcpy(out->text,"127.0.0.1");return ERR_OK;
}
static int connect_async(esp_transport_handle_t, const char* host, int port, int timeout) {
    assert(verified && !strcmp(host,"127.0.0.1") && port==443 && timeout>0);
    return connect_failure ? -1 : 1;
}
static int socket_read(esp_transport_handle_t, char* out, int n, int timeout) {
    ++reads;
    if (partial_record && reads % 2 == 1) return ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
    assert(timeout>0 && now + int64_t(timeout)*1000 <= 20000000);
    int wait=std::min(delay_ms,timeout);now+=wait*1000;
    if(wait<delay_ms) return 0;
    size_t count=std::min({size_t(n),quantum,response.size()-offset});
    if(!count) return -1;
    memcpy(out,response.data()+offset,count);offset+=count;return count;
}
static int socket_write(esp_transport_handle_t,const char*,int n,int) {return n;}
static int socket_close(esp_transport_handle_t) {++closes;return 0;}
static int socket_destroy(esp_transport_handle_t) {--live;return 0;}
extern "C" esp_transport_handle_t esp_transport_ssl_init() {
    ++live;
    auto t=esp_transport_init();
    esp_transport_set_func(t,nullptr,socket_read,socket_write,socket_close,nullptr,nullptr,socket_destroy);
    esp_transport_set_async_connect_func(t,connect_async);
    return t;
}
extern "C" esp_transport_handle_t esp_transport_tcp_init() {return esp_transport_ssl_init();}
extern "C" void esp_transport_ssl_set_cert_data(esp_transport_handle_t,const char*,int) {verified=true;}
extern "C" void esp_transport_ssl_crt_bundle_attach(esp_transport_handle_t,esp_err_t(*)(void*)) {verified=true;}
#define NOOP_DATA(name) extern "C" void name(esp_transport_handle_t,const char*,int) {}
NOOP_DATA(esp_transport_ssl_set_cert_data_der)
NOOP_DATA(esp_transport_ssl_set_client_cert_data)
NOOP_DATA(esp_transport_ssl_set_client_cert_data_der)
NOOP_DATA(esp_transport_ssl_set_client_key_data)
NOOP_DATA(esp_transport_ssl_set_client_key_data_der)
NOOP_DATA(esp_transport_ssl_set_client_key_password)
extern "C" void esp_transport_ssl_set_tls_version(esp_transport_handle_t,esp_tls_proto_ver_t) {}
extern "C" void esp_transport_ssl_set_addr_family(esp_transport_handle_t,esp_tls_addr_family_t) {}
extern "C" void esp_transport_ssl_set_alpn_protocol(esp_transport_handle_t,const char**) {}
extern "C" void esp_transport_ssl_enable_global_ca_store(esp_transport_handle_t) {}
extern "C" void esp_transport_ssl_skip_common_name_check(esp_transport_handle_t) {assert(false);}
extern "C" void esp_transport_ssl_set_common_name(esp_transport_handle_t,const char* host) {assert(!strcmp(host,"disposable.test"));}
extern "C" void esp_transport_tcp_set_keep_alive(esp_transport_handle_t,esp_transport_keep_alive_t*) {}
extern "C" void esp_transport_tcp_set_interface_name(esp_transport_handle_t,struct ifreq*) {}
extern "C" char* http_auth_basic(const char*,const char*) {assert(false);return nullptr;}
static HttpResult request(const std::string& wire,int delay=0,size_t chunk=512) {
    now=0;response=wire;offset=0;quantum=chunk;delay_ms=delay;reads=closes=0;verified=false;
    esp_http_client_config_t config{};
    config.url="https://disposable.test/api/v1/devices/redeem";
    config.cert_pem="host TLS stub; verification separately tested with SDK mbedTLS";
    auto result=cube_http_post(config,"{}");
    assert(live==0 && (closes>0 || dns_mode || connect_failure) && now<=20000000);
    return result;
}
int main() {
    auto valid=request("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
    assert(valid.status==200 && valid.body=="{}"); // Body cached during headers.
    assert(valid.diagnostic.http_status==200 && valid.diagnostic.body_bytes==2 &&
           valid.diagnostic.received_bytes==response.size() && valid.diagnostic.sent_bytes>2 &&
           !strcmp(valid.diagnostic.phase,"complete"));
    // Activation-sized flat token response crosses header cache and 512-byte reads.
    // A partial nonblocking TLS record is retryable, not a failed HTTP response.
    partial_record=true;
    std::string activation="{\"version\":1,\"token\":\""+std::string(1200,'x')+"\"}";
    auto split=request("HTTP/1.1 200 OK\r\nContent-Length: "+std::to_string(activation.size())+"\r\n\r\n"+activation,0,128);
    assert(split.status==200 && split.body==activation && split.diagnostic.body_bytes==activation.size());
    partial_record=false;
    connect_failure=true;
    auto failed=request("");
    assert(!failed.status && !strcmp(failed.diagnostic.phase,"tls-connect") &&
           failed.diagnostic.error_code==-1 && failed.diagnostic.received_bytes==0 &&
           failed.diagnostic.internal_largest_bytes==7680);
    connect_failure=false;
    auto exact=request("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n"+std::string(4096,'x'));
    assert(exact.status==200 && exact.body.size()==4096);
    auto declared=request("HTTP/1.1 200 OK\r\nContent-Length: 4097\r\n\r\n"+std::string(4097,'x'));
    assert(!declared.status && declared.overflow && reads==1);
    assert(declared.diagnostic.http_status==200 && !strcmp(declared.diagnostic.phase,"overflow"));
    std::string chunked="HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
    auto full=request(chunked+"1000\r\n"+std::string(4096,'x')+"\r\n0\r\n\r\n");
    assert(full.status==200 && full.body.size()==4096);
    auto overflow=request(chunked+"1001\r\n"+std::string(4097,'x')+"\r\n0\r\n\r\n"+std::string(10000,'z'));
    assert(!overflow.status && overflow.overflow && overflow.body.size()<=4096 && offset<5000);
    std::string drip=chunked;
    for(int i=0;i<500;i++) drip+="1\r\nx\r\n";
    auto slow=request(drip,900,1); // Never hits per-read 10s timeout; total must stop.
    assert(!slow.status && reads<=23 && now==20000000);
    assert(slow.diagnostic.timed_out && !strcmp(slow.diagnostic.phase,"headers") && slow.diagnostic.elapsed_ms==20000);
    // Reach headers promptly, then drip chunked body below each per-read timeout.
    auto body_slow=request(drip,900,64);
    assert(!body_slow.status && now==20000000 && reads<=23);
    auto incomplete=request(chunked+"10\r\nx");assert(!incomplete.status);
    auto redirect=request("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 0\r\n\r\n");
    assert(redirect.status==302 && reads==1);
    for(auto header:{"0","1","300","301","3600","999999999999999999999999"}) {
        auto result=request(std::string("HTTP/1.1 429 Retry\r\nRetry-After: ")+header+"\r\nContent-Length: 0\r\n\r\n");
        assert(result.status==429 && result.retry_after==cube_retry_after(header));
    }
    assert(cube_retry_after("0")==1 && cube_retry_after("3600")==300);
    assert(cube_retry_after("999999999999999999999999")==300);
    assert(cube_retry_after("-1")==0 && cube_retry_after("date")==0 && cube_retry_after("")==0);
    dns_mode=1;
    auto dns_timeout=request("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    assert(!dns_timeout.status && now==20000000 && reads==0 && semaphores==1);
    assert(dns_timeout.diagnostic.timed_out && !strcmp(dns_timeout.diagnostic.phase,"dns"));
    auto blocked=request("");assert(!blocked.status && reads==0 && semaphores==1);
    pending_dns(nullptr,nullptr,pending_context); // Late completion after request destruction.
    assert(semaphores==0 && !CubeDnsLookup::busy.load());
    dns_mode=2;auto rejected=request("");assert(!rejected.status && semaphores==0);

}
