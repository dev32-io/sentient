"""Fail-closed build-local corrections for IDF 5.5.2 Security2 patch 1.
No wire/crypto changes: validate decoded unions, retain SRP ownership until
session reset, accept minimal-width native A, and release temporary RNG state.
"""
from pathlib import Path
import hashlib
import sys


def patch(source: str) -> str:
    if hashlib.sha256(source.encode()).hexdigest() != 'd6dedb2b759c4ae45c1c88ff251de4ba1f830e5b896c0193ef01ce69c2a862bc':
        raise ValueError('Security2 upstream changed; review Cube corrections before building')
    source = source.replace('in->sc0->client_pubkey.len != PUBLIC_KEY_LEN',
                            '!in->sc0->client_pubkey.len || in->sc0->client_pubkey.len > PUBLIC_KEY_LEN')
    source = source.replace('(char *) in->sc0->client_pubkey.data, PUBLIC_KEY_LEN',
                            '(char *) in->sc0->client_pubkey.data, in->sc0->client_pubkey.len')
    # SRP owns B/session_key. One owner (session close) releases them, including
    # failed Cmd0 and output allocation failure. Never leave dangling aliases.
    source = source.replace('            esp_srp_free(cur_session->srp_hd);\n', '')
    source = source.replace('        esp_srp_free(cur_session->srp_hd);\n', '')
    source = source.replace('    if (cur_session->srp_hd) {\n    }',
                            '    esp_srp_free(cur_session->srp_hd);\n    cur_session->srp_hd = NULL;')
    source = source.replace('sec2_close_session(cur_session, session_id);',
                            'sec2_close_session(cur_session, cur_session->id);')
    source = source.replace('    if (sv == NULL) {',
                            '    if (!sv || !sv->salt || !sv->salt_len || !sv->verifier || !sv->verifier_len) {')
    source = source.replace('        ESP_LOGE(TAG, "Failed to seed random number generator");',
                            '        mbedtls_ctr_drbg_free(&ctr_drbg);\n        mbedtls_entropy_free(&entropy);\n        ESP_LOGE(TAG, "Failed to seed random number generator");')
    source = source.replace('    ret = mbedtls_ctr_drbg_random(&ctr_drbg, iv->session_id, SESSION_ID_LEN);',
                            '    ret = mbedtls_ctr_drbg_random(&ctr_drbg, iv->session_id, SESSION_ID_LEN);\n    mbedtls_ctr_drbg_free(&ctr_drbg);\n    mbedtls_entropy_free(&entropy);')
    source = source.replace('    if (!in) {', '''    if (req->proto_case != SESSION_DATA__PROTO_SEC2 || !in ||
        !((in->msg == SEC2_MSG_TYPE__S2Session_Command0 &&
           in->payload_case == SEC2_PAYLOAD__PAYLOAD_SC0 && in->sc0 &&
           in->sc0->client_pubkey.data && in->sc0->client_pubkey.len > 0 &&
           in->sc0->client_pubkey.len <= PUBLIC_KEY_LEN &&
           in->sc0->client_username.data && in->sc0->client_username.len > 0 &&
           in->sc0->client_username.len <= UINT16_MAX) ||
          (in->msg == SEC2_MSG_TYPE__S2Session_Command1 &&
           in->payload_case == SEC2_PAYLOAD__PAYLOAD_SC1 && in->sc1 &&
           in->sc1->client_proof.data && in->sc1->client_proof.len == CLIENT_PROOF_LEN))) {''')
    source = source.replace('    req = session_data__unpack(NULL, inlen, inbuf);', '''    /* Bound unauthenticated protobuf allocations before decoding. */
    if (!inbuf || inlen <= 0 || inlen > 512 || !outbuf || !outlen) {
        return ESP_ERR_INVALID_ARG;
    }
    *outbuf = NULL;
    *outlen = 0;
    req = session_data__unpack(NULL, inlen, inbuf);''')
    source = source.replace('if (req->sec_ver != protocomm_security2.ver)',
                            'if (req->sec_ver != protocomm_security2.ver || req->proto_case != SESSION_DATA__PROTO_SEC2)')
    source = source.replace('        ESP_LOGE(TAG, "Session setup error %d", ret);',
                            '        sec2_close_session(cur_session, session_id);\n        cur_session->id = session_id;\n        ESP_LOGE(TAG, "Session setup error %d", ret);')
    source = source.replace('        ESP_LOGE(TAG, "System out of memory");',
                            '        sec2_session_setup_cleanup(cur_session, session_id, &resp);\n        sec2_close_session(cur_session, session_id);\n        cur_session->id = session_id;\n        ESP_LOGE(TAG, "System out of memory");')
    return source


if __name__ == '__main__':
    source, destination = map(Path, sys.argv[1:])
    result = patch(source.read_text())
    if not destination.exists() or destination.read_text() != result:
        destination.write_text(result)
