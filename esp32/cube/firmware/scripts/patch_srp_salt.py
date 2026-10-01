"""Build-local IDF 5.5.2 SRP salt serialization fix; no cryptographic changes.

esp_mpi_to_bin drops leading zero bytes, while the public salt/verifier API
returns no salt length. Pad BEFORE calculating x, so clients hash the same
fixed-width salt that the API contract exposes. Never edit the installed IDF.
"""
from pathlib import Path
import sys

ANCHOR = "    hd->len_s = salt_len;\n    ESP_LOGD(TAG, \"Salt ->\");"
REPLACEMENT = """    /* Sentient: public generator promises salt_len bytes, but MPI serialization
     * is minimal-width. Preserve leading zeros before hashing and exporting. */
    if (str_salt_len < salt_len) {
        char *padded_salt = calloc(1, salt_len);
        if (!padded_salt) {
            goto error;
        }
        memcpy(padded_salt + salt_len - str_salt_len, hd->bytes_s, str_salt_len);
        free(hd->bytes_s);
        hd->bytes_s = padded_salt;
        str_salt_len = salt_len;
    }
    hd->len_s = salt_len;
    ESP_LOGD(TAG, "Salt ->");"""


def patch(source: str) -> str:
    if source.count(ANCHOR) != 1:
        raise ValueError("IDF SRP source changed; review upstream salt-length fix before building Cube")
    return source.replace(ANCHOR, REPLACEMENT)


if __name__ == '__main__':
    source, destination = map(Path, sys.argv[1:])
    result = patch(source.read_text())
    if not destination.exists() or destination.read_text() != result:
        destination.write_text(result)
