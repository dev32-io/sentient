/* Included after disposable vectors by test_cube_security2_sdk.py. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <protocomm_security2.h>
#include <esp_srp.h>
#include <mbedtls/gcm.h>
#include <mbedtls/ctr_drbg.h>
#include "session.pb-c.h"
#include "sec2.pb-c.h"
extern void test_fail(long);
extern long test_live(void);
extern long test_calls(void);
static int rng_fail;
int test_seed(mbedtls_ctr_drbg_context* c,int(*f)(void*,unsigned char*,size_t),void* p,const unsigned char* custom,size_t n) {
    int ret=mbedtls_ctr_drbg_seed(c,f,p,custom,n);
    return rng_fail==1 ? -1 : ret;
}
int test_random(void* c,unsigned char* out,size_t n) {
    int ret=mbedtls_ctr_drbg_random(c,out,n);
    return rng_fail==2 ? -1 : ret;
}
static const protocomm_security_t *api = &protocomm_security2;
static protocomm_security2_params_t params;
static protocomm_security_handle_t handle;

static int wire(const uint8_t *data, ssize_t len, SessionData **response) {
    uint8_t *out = NULL;
    ssize_t outlen = 0;
    int ret = api->security_req_handler(handle, &params, 7, data, len, &out, &outlen, NULL);
    if (ret == ESP_OK && response) {
        *response = session_data__unpack(NULL, outlen, out);
        assert(*response);
    }
    free(out);
    return ret;
}
static int command(Sec2Payload *payload, SessionData **response) {
    SessionData req = SESSION_DATA__INIT;
    req.sec_ver = SEC_SCHEME_VERSION__SecScheme2;
    req.proto_case = SESSION_DATA__PROTO_SEC2;
    req.sec2 = payload;
    uint8_t packed[1024];
    size_t n = session_data__pack(&req, packed);
    return wire(packed, n, response);
}
static int cmd0(unsigned char *A, size_t n, SessionData **response) {
    S2SessionCmd0 cmd = S2_SESSION_CMD0__INIT;
    cmd.client_username = (ProtobufCBinaryData){4, (uint8_t *)"cube"};
    cmd.client_pubkey = (ProtobufCBinaryData){n, A};
    Sec2Payload p = SEC2_PAYLOAD__INIT;
    p.payload_case = SEC2_PAYLOAD__PAYLOAD_SC0;
    p.sc0 = &cmd;
    return command(&p, response);
}
static void reset(void) {
    test_fail(-1);
    assert(api->close_transport_session(handle, 7) == ESP_OK);
    assert(api->new_transport_session(handle, 7) == ESP_OK);
}
static void proofs(SessionData *r, int index, unsigned char *proof) {
    printf("B %d ", index);
    ProtobufCBinaryData B = r->sec2->sr0->device_pubkey;
    for (size_t i=0;i<B.len;i++) printf("%02x", B.data[i]);
    puts(""); fflush(stdout);
    for (int i=0;i<192;i++) { unsigned n; assert(scanf("%2x", &n)==1); proof[i]=n; }
}
static int cmd1(unsigned char *proof, SessionData **response) {
    S2SessionCmd1 cmd = S2_SESSION_CMD1__INIT;
    cmd.client_proof = (ProtobufCBinaryData){64, proof};
    Sec2Payload p = SEC2_PAYLOAD__INIT;
    p.msg = SEC2_MSG_TYPE__S2Session_Command1;
    p.payload_case = SEC2_PAYLOAD__PAYLOAD_SC1;
    p.sc1 = &cmd;
    return command(&p, response);
}
int main(void) {
    params = (protocomm_security2_params_t){(char*)salt,sizeof(salt),(char*)verifier,sizeof(verifier)};
    assert(api->patch_ver == 1);
    assert(api->init(&handle)==ESP_OK);
    assert(api->new_transport_session(handle,7)==ESP_OK);
    long baseline = test_live();
    // Reported four-byte null Cmd0, truncated lengths, wrong outer oneof.
    unsigned char empty[] = {0x10,2,0x62,0};
    assert(wire(empty,sizeof(empty),NULL)!=ESP_OK);
    unsigned char truncated[] = {0x10,2,0x62,0xff,0xff};
    assert(wire(truncated,sizeof(truncated),NULL)!=ESP_OK);
    unsigned char wrong_outer[] = {0x10,2,0x52,0};
    assert(wire(wrong_outer,sizeof(wrong_outer),NULL)!=ESP_OK);
    assert(wire(empty,-1,NULL)!=ESP_OK);
    assert(wire(empty,513,NULL)!=ESP_OK);
    S2SessionCmd1 badcmd = S2_SESSION_CMD1__INIT;
    Sec2Payload bad = SEC2_PAYLOAD__INIT;
    bad.payload_case = SEC2_PAYLOAD__PAYLOAD_SC1;
    bad.sc1 = &badcmd; // Cmd0 discriminant + Cmd1 payload.
    assert(command(&bad,NULL)!=ESP_OK);
    bad.msg = SEC2_MSG_TYPE__S2Session_Command1;
    assert(command(&bad,NULL)!=ESP_OK); // Empty proof.
    unsigned char wrong_proof[65]={0};
    badcmd.client_proof=(ProtobufCBinaryData){63,wrong_proof};
    assert(command(&bad,NULL)!=ESP_OK);
    badcmd.client_proof.len=65;assert(command(&bad,NULL)!=ESP_OK);
    bad.msg=(Sec2MsgType)99;assert(command(&bad,NULL)!=ESP_OK);
    S2SessionCmd0 no_user=S2_SESSION_CMD0__INIT;
    no_user.client_pubkey=(ProtobufCBinaryData){sizeof(A0),A0};
    bad.msg=SEC2_MSG_TYPE__S2Session_Command0;
    bad.payload_case=SEC2_PAYLOAD__PAYLOAD_SC0;bad.sc0=&no_user;
    assert(command(&bad,NULL)!=ESP_OK);
    bad.msg=SEC2_MSG_TYPE__S2Session_Command1;assert(command(&bad,NULL)!=ESP_OK);
    unsigned char zero[385]={0};
    assert(cmd0(zero,0,NULL)!=ESP_OK);
    assert(cmd0(zero,385,NULL)!=ESP_OK);
    assert(cmd0(zero,384,NULL)!=ESP_OK); reset();
    assert(cmd0(modulus,sizeof(modulus),NULL)!=ESP_OK); reset();
    assert(test_live()==baseline);
    // Same guard applies at shared SRP API, not only BLE dispatch.
    esp_srp_handle_t *srp=esp_srp_init(ESP_NG_3072);
    assert(srp);
    assert(esp_srp_set_salt_verifier(srp,(char*)salt,sizeof(salt),(char*)verifier,sizeof(verifier))==ESP_OK);
    char *B=NULL,*K=NULL;int blen=0;uint16_t klen=0;
    assert(esp_srp_srv_pubkey_from_salt_verifier(srp,&B,&blen)==ESP_OK);
    assert(esp_srp_get_session_key(srp,(char*)modulus,sizeof(modulus),&K,&klen)!=ESP_OK);
    assert(!K && klen==0);
    esp_srp_free(srp);
    assert(test_live()==baseline);
    // One-shot allocation failure sweep across decoder, SRP/MPI, and response.
    test_fail(-1);
    assert(cmd0(A0,sizeof(A0),NULL)==ESP_OK);
    long count = test_calls(); reset();
    for(long n=0;n<count;n++) {
        test_fail(n);
        cmd0(A0,sizeof(A0),NULL);
        reset();
        assert(test_live()==baseline);
    }
    // Complete native-width handshakes; reciprocal proof and patch-1 AES wire.
    for(int cycle=0;cycle<33;cycle++) {
        int index=cycle%3;
        SessionData *r=NULL;
        assert(cmd0(index==2?A2:index?A1:A0,index==2?sizeof(A2):index?sizeof(A1):sizeof(A0),&r)==ESP_OK);
        unsigned char proof[192]; proofs(r,index,proof);
        session_data__free_unpacked(r,NULL);
        if(cycle==0) { // Wrong proof leaves cleanly reset session.
            proof[0]^=1; assert(cmd1(proof,NULL)!=ESP_OK); reset();
            assert(test_live()==baseline); continue;
        }
        assert(cmd1(proof,&r)==ESP_OK);
        assert(r->sec2->sr1->device_proof.len==64);
        assert(!memcmp(r->sec2->sr1->device_proof.data,proof+64,64));
        unsigned char nonce[12]; memcpy(nonce,r->sec2->sr1->device_nonce.data,12);
        assert(nonce[8]==0 && nonce[9]==0 && nonce[10]==0 && nonce[11]==1);
        mbedtls_gcm_context gcm; mbedtls_gcm_init(&gcm);
        assert(!mbedtls_gcm_setkey(&gcm,MBEDTLS_CIPHER_ID_AES,proof+128,256));
        uint8_t *encrypted=NULL;ssize_t encrypted_len=0;
        assert(api->encrypt(handle,7,(uint8_t*)"test",4,&encrypted,&encrypted_len)==ESP_OK);
        assert(encrypted_len==20);
        unsigned char plain[4];
        assert(!mbedtls_gcm_auth_decrypt(&gcm,4,nonce,12,NULL,0,encrypted+4,16,encrypted,plain));
        assert(!memcmp(plain,"test",4));
        free(encrypted);mbedtls_gcm_free(&gcm);
        session_data__free_unpacked(r,NULL);
        // Replacement with a different transport id must release old owner.
        assert(api->new_transport_session(handle,8)==ESP_OK);
        assert(api->new_transport_session(handle,7)==ESP_OK);
        assert(test_live()==baseline);
    }
    // Sweep Cmd1 allocation failures, including entropy/DRBG init and seed.
    for(long n=0;n<40;n++) {
        SessionData *r=NULL;
        assert(cmd0(A1,sizeof(A1),&r)==ESP_OK);
        unsigned char proof[192];proofs(r,1,proof);session_data__free_unpacked(r,NULL);
        test_fail(n);cmd1(proof,NULL);reset();assert(test_live()==baseline);
    }
    for(rng_fail=1;rng_fail<=2;rng_fail++) {
        SessionData *r=NULL;
        assert(cmd0(A1,sizeof(A1),&r)==ESP_OK);
        unsigned char proof[192];proofs(r,1,proof);session_data__free_unpacked(r,NULL);
        assert(cmd1(proof,NULL)!=ESP_OK);reset();assert(test_live()==baseline);
    }
    api->cleanup(handle);
    assert(test_live()==0);
    return 0;
}
