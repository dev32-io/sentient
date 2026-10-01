"""IDF SRP boundary/error handling fixes; algorithms and proof widths unchanged."""
from pathlib import Path
import hashlib
import sys
from patch_srp_salt import patch as patch_salt


def patch(source: str) -> str:
    if hashlib.sha256(source.encode()).hexdigest() != '060268ed7d670d90304c0c4d4515edd89521e30645316f7fb33d3a5169f5aa63':
        raise ValueError('SRP upstream changed; review Cube corrections before building')
    source = patch_salt(source)
    source = source.replace('''        if (s) {
            memset(s, 0, pad_len);
        }''', '''        if (!s) {
            return NULL;
        }
        memset(s, 0, pad_len);''')
    # Propagate existing library failures instead of hashing an unset MPI.
    lines = source.splitlines()
    for i, line in enumerate(lines):
        if line.strip().startswith(('esp_mpi_get_rand(', 'esp_mpi_a_exp_b_mod_c(',
                                    'esp_mpi_a_mul_b_mod_c(', 'esp_mpi_a_add_b_mod_c(')):
            lines[i] = '    if (' + line.strip().removesuffix(';') + ' != 0) { goto error; }'
    source = '\n'.join(lines) + '\n'
    source = source.replace('    hd->len_B = *len_B;',
                            '    if (!hd->bytes_B) { goto error; }\n    hd->len_B = *len_B;')
    source = source.replace('    esp_mpi_t *u = NULL;', '''    if (!hd || !bytes_A || len_A <= 0 || len_A > hd->len_n ||
        !bytes_key || !len_key || !hd->v || !hd->b || !hd->bytes_B || hd->A) {
        return ESP_ERR_INVALID_ARG;
    }
    *bytes_key = NULL;
    *len_key = 0;
    esp_mpi_t *u = NULL;''')
    source = source.replace('    u = calculate_u(hd, bytes_A, len_A);', '''    /* RFC 5054: abort if A mod N == 0, before calculating a shared secret.
     * esp_mpi_t is the SDK's mbedtls_mpi; use its checked standard operation. */
    mbedtls_mpi remainder;
    mbedtls_mpi_init(&remainder);
    int mod_ret = mbedtls_mpi_mod_mpi(&remainder, hd->A, hd->n);
    int invalid_A = mod_ret != 0 || mbedtls_mpi_cmp_int(&remainder, 0) == 0;
    mbedtls_mpi_free(&remainder);
    if (invalid_A) { goto error; }
    u = calculate_u(hd, bytes_A, len_A);''')
    return source


if __name__ == '__main__':
    source, destination = map(Path, sys.argv[1:])
    result = patch(source.read_text())
    if not destination.exists() or destination.read_text() != result:
        destination.write_text(result)
