"""Release SDK MPI temporaries on arithmetic/allocation errors."""
from pathlib import Path
import hashlib
import sys


def patch(source: str) -> str:
    if hashlib.sha256(source.encode()).hexdigest() != '22fe3eef0418d3064874a6582699fb26bf961167092b814cc3f9b5f06da5e70d':
        raise ValueError('SRP MPI upstream changed; review Cube cleanup before building')
    # Both modular helpers own t, including their early returns.
    source = source.replace('        return res;', '        mbedtls_mpi_free(&t);\n        return res;')
    return source


if __name__ == '__main__':
    source, destination = map(Path, sys.argv[1:])
    result = patch(source.read_text())
    if not destination.exists() or destination.read_text() != result:
        destination.write_text(result)
