#!/bin/sh
set -eu
python3 /app/tests/test_exec_client.py
python3 /app/tests/test_service.py
