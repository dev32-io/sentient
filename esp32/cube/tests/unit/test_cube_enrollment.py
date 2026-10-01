"""Host execution of production enrollment validation and NVS/publication boundary."""
from pathlib import Path
import subprocess

BOARD = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube'


def test_enrollment_persistence_and_authority(tmp_path):
    (tmp_path / 'esp_err.h').write_text('''#pragma once
using esp_err_t = int;
constexpr int ESP_OK=0, ESP_FAIL=1, ESP_ERR_INVALID_STATE=2, ESP_ERR_NVS_NOT_FOUND=3;
''')
    (tmp_path / 'esp_partition.h').write_text('''#pragma once
#include "esp_err.h"
#include <cstddef>
#include <cstdint>
enum esp_partition_subtype_t { ESP_PARTITION_SUBTYPE_DATA_NVS=2 };
constexpr int ESP_PARTITION_TYPE_DATA=1;
struct esp_partition_t { uint32_t address; uint32_t size; };
const esp_partition_t* esp_partition_find_first(int, esp_partition_subtype_t, const char*);
esp_err_t esp_partition_read(const esp_partition_t*, size_t, void*, size_t);
esp_err_t esp_partition_write(const esp_partition_t*, size_t, const void*, size_t);
''')
    (tmp_path / 'nvs.h').write_text('''#pragma once
#include "esp_err.h"
#include <cstddef>
using nvs_handle_t = unsigned;
constexpr int NVS_READWRITE=1;
esp_err_t nvs_open_from_partition(const char*, const char*, int, nvs_handle_t*);
esp_err_t nvs_get_blob(nvs_handle_t, const char*, void*, size_t*);
esp_err_t nvs_set_blob(nvs_handle_t, const char*, const void*, size_t);
esp_err_t nvs_commit(nvs_handle_t);
''')
    (tmp_path / 'nvs_flash.h').write_text('''#pragma once
#include "esp_err.h"
esp_err_t nvs_flash_init_partition(const char*);
''')
    (tmp_path / 'main.cc').write_text(r'''
#include "cube_enrollment_store.h"
#include <cassert>
#include <vector>
using namespace sentient::cube;
esp_partition_t auth{0x10000,0xf000}, seal{0x1f000,0x1000};
std::vector<uint8_t> auth_bytes(auth.size,255), seal_bytes(seal.size,255), blob, pending;
int writes=0, write_budget=-1, init_error=0;
bool lose_commit_ack=false;
const esp_partition_t* esp_partition_find_first(int,esp_partition_subtype_t,const char* label) {
    return !strcmp(label,"cube_auth") ? &auth : &seal;
}
esp_err_t esp_partition_read(const esp_partition_t* p,size_t at,void* out,size_t n) {
    auto& bytes=p==&auth ? auth_bytes : seal_bytes;
    assert(at+n<=bytes.size()); memcpy(out,bytes.data()+at,n); return ESP_OK;
}
esp_err_t esp_partition_write(const esp_partition_t* p,size_t at,const void* in,size_t n) {
    assert(p==&seal); ++writes;
    auto* src=static_cast<const uint8_t*>(in);
    for(size_t i=0;i<n;++i) {
        if(write_budget==0) return ESP_FAIL;
        if(write_budget>0) --write_budget;
        seal_bytes[at+i] &= src[i];
    }
    return ESP_OK;
}
esp_err_t nvs_flash_init_partition(const char* name) { assert(!strcmp(name,"cube_auth")); return init_error; }
esp_err_t nvs_open_from_partition(const char* p,const char*,int,nvs_handle_t* h) {
    assert(!strcmp(p,"cube_auth")); *h=1; return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t,const char*,void* out,size_t* n) {
    if(blob.empty()) return ESP_ERR_NVS_NOT_FOUND;
    if(*n<blob.size()) return ESP_FAIL;
    *n=blob.size(); memcpy(out,blob.data(),blob.size()); return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t,const char*,const void* in,size_t n) {
    auto* src=static_cast<const uint8_t*>(in); pending.assign(src,src+n); return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t) {
    blob=pending; return lose_commit_ack ? ESP_FAIL : ESP_OK;
}
void reset() {
    std::fill(auth_bytes.begin(),auth_bytes.end(),255);
    std::fill(seal_bytes.begin(),seal_bytes.end(),255);
    blob.clear(); pending.clear(); writes=0; write_budget=-1; init_error=0; lose_commit_ack=false;
}
CubeEnrollment fresh() {
    CubeEnrollment r;
    cube_copy(r.device_id,"12345678-1234-4234-8234-123456789abc");
    cube_copy(r.bootstrap,std::string(43,'A')); assert(r.valid()); return r;
}
CubeEnrollment enrolled(CubeEnrollment r) {
    r.phase=EnrollmentPhase::Pending; r.generation=1;
    cube_copy(r.attempt_id,"22345678-1234-4234-8234-123456789abc");
    cube_copy(r.enrollment,std::string(43,'B').replace(42,1,"A"));
    cube_copy(r.renewal,std::string(43,'C').replace(42,1,"A"));
    cube_copy(r.origin,"https://gateway.test:443"); cube_copy(r.ws_path,"/ws");
    memset(r.bootstrap,0,sizeof(r.bootstrap)); memset(r.salt,7,32); memset(r.verifier,8,384);
    assert(r.valid()); return r;
}
int main() {
    assert(cube_secret(std::string(43,'A')));
    assert(!cube_secret(std::string(43,'B'))); // Noncanonical final base64 bits.
    assert(!cube_secret(std::string(43,'A')+'='));
    assert(cube_wifi(std::string(32,'s'),std::string(64,'a')));
    assert(!cube_wifi("ssid",std::string(64,'x')));
    assert(!cube_wifi(std::string("a\0b",3),"password"));
    for(auto url : {"http://host","https://host/path","https://user@host","https://host?x","https://host:0","https://host:65536"}) assert(!cube_origin(url));
    assert(cube_flat_object(R"({"x":"[{}]","n":1})"));
    assert(!cube_flat_object(R"({"x":{"n":1}})"));
    assert(!cube_flat_object(R"({"x":[1]})"));
    reset(); CubeEnrollment r; CubeEnrollmentStore s;
    assert(s.Open(r)==ESP_ERR_NVS_NOT_FOUND);
    r=fresh(); assert(s.Save(r)==ESP_OK);
    CubeEnrollment loaded; CubeEnrollmentStore reboot;
    assert(reboot.Open(loaded)==ESP_OK && !memcmp(&r,&loaded,sizeof(r)));
    auto next=enrolled(r);
    lose_commit_ack=true; assert(reboot.Save(next)!=ESP_OK); // Actual durable write, reply lost.
    lose_commit_ack=false; CubeEnrollmentStore again;
    assert(again.Open(loaded)==ESP_OK && loaded.phase==EnrollmentPhase::Pending && loaded.bootstrap[0]==0);
    assert(loaded.same_attempt(next.attempt_id,1,next.enrollment));
    loaded.phase=EnrollmentPhase::Active; loaded.confirmed_generation=1;
    assert(loaded.valid());
    assert(!loaded.can_enroll("32345678-1234-4234-8234-123456789abc",1,next.enrollment,next.origin,next.ws_path));
    assert(loaded.can_enroll("32345678-1234-4234-8234-123456789abc",2,next.enrollment,next.origin,next.ws_path));
    assert(!loaded.can_enroll("32345678-1234-4234-8234-123456789abc",2,next.enrollment,"https://other.test",next.ws_path));
    // A bogus uncommitted higher generation cannot permanently poison recovery.
    loaded.phase=EnrollmentPhase::Pending; loaded.generation=999;
    assert(loaded.can_enroll("32345678-1234-4234-8234-123456789abc",2,next.enrollment,next.origin,next.ws_path));
    blob.clear(); CubeEnrollmentStore missing;
    assert(missing.Open(loaded)==ESP_ERR_INVALID_STATE); // Published identity may never become fresh.
    reset(); auth_bytes[100]=0; CubeEnrollmentStore migration;
    assert(migration.Open(loaded)==ESP_ERR_INVALID_STATE && writes==0);
    // Power loss at every byte of initial marker; unpublished initialization resumes.
    for(int cut=0;cut<4;++cut) {
        reset(); write_budget=cut; CubeEnrollmentStore partial;
        assert(partial.Open(loaded)!=ESP_OK); write_budget=-1;
        CubeEnrollmentStore resume; assert(resume.Open(loaded)==ESP_ERR_NVS_NOT_FOUND);
        assert(resume.Save(fresh())==ESP_OK);
    }
    // Power loss while publishing: retained record reused, not regenerated.
    for(int cut=0;cut<4;++cut) {
        reset(); CubeEnrollmentStore partial; assert(partial.Open(loaded)==ESP_ERR_NVS_NOT_FOUND);
        write_budget=cut; assert(partial.Save(r)!=ESP_OK); write_budget=-1;
        CubeEnrollmentStore resume; assert(resume.Open(loaded)==ESP_OK);
        assert(!memcmp(&loaded,&r,sizeof(r)));
    }
    auto corrupt=r; corrupt.schema=999;
    blob.assign(reinterpret_cast<uint8_t*>(&corrupt),reinterpret_cast<uint8_t*>(&corrupt)+sizeof(corrupt));
    CubeEnrollmentStore invalid; assert(invalid.Open(loaded)==ESP_ERR_INVALID_STATE);
    reset(); init_error=ESP_FAIL; CubeEnrollmentStore broken;
    assert(broken.Open(loaded)==ESP_FAIL); // No erase-and-retry API even linked.
}
''')
    binary = tmp_path / 'check'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    '-I', str(tmp_path), '-I', str(BOARD), str(tmp_path / 'main.cc'),
                    str(BOARD / 'cube_enrollment_store.cc'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
