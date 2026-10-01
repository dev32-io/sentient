"""SDK mbedTLS rejects signed, hostname-matching expired/future certificates."""
from pathlib import Path
import subprocess
from test_cube_security2_sdk import run, sdk_host_build


def test_sdk_certificate_dates(tmp_path):
    inc, mbed = sdk_host_build(tmp_path)
    # Disposable host-only key. No real enrollment/account data.
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=disposable.test', '-addext', 'subjectAltName=DNS:disposable.test',
        '-keyout', tmp_path / 'key.pem', '-out', tmp_path / 'cert.pem',
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    source = tmp_path / 'dates.c'
    source.write_text('''#include <assert.h>
#include <time.h>
#include <mbedtls/x509_crt.h>
extern void test_time_shift(time_t);
int main(int argc,char**argv) {
    assert(argc==2);
    mbedtls_x509_crt cert;mbedtls_x509_crt_init(&cert);
    assert(!mbedtls_x509_crt_parse_file(&cert,argv[1]));
    uint32_t flags=0;
    assert(!mbedtls_x509_crt_verify(&cert,&cert,NULL,"disposable.test",&flags,NULL,NULL));
    assert(!flags);
    test_time_shift(172800);
    assert(mbedtls_x509_crt_verify(&cert,&cert,NULL,"disposable.test",&flags,NULL,NULL));
    assert(flags & MBEDTLS_X509_BADCERT_EXPIRED);
    test_time_shift(-172800);
    assert(mbedtls_x509_crt_verify(&cert,&cert,NULL,"disposable.test",&flags,NULL,NULL));
    assert(flags & MBEDTLS_X509_BADCERT_FUTURE);
    test_time_shift(0);
    assert(mbedtls_x509_crt_verify(&cert,&cert,NULL,"wrong.test",&flags,NULL,NULL));
    assert(flags & MBEDTLS_X509_BADCERT_CN_MISMATCH);
    mbedtls_x509_crt_free(&cert);
}
''')
    run('cc', '-fsanitize=address', f'-I{mbed}/include', source, tmp_path / 'alloc.c',
        tmp_path / 'mbed/library/libmbedx509.a', tmp_path / 'mbed/library/libmbedcrypto.a',
        '-o', tmp_path / 'dates')
    run(tmp_path / 'dates', tmp_path / 'cert.pem')
