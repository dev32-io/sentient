# Hermes e2e integration tests

Tests run against a real `sentient-hermes:slim` container that you start
MANUALLY before running the suite. No programmatic docker-compose calls
in test code.

## Setup

1. Build the slim image (Phase 1.1 may have done this already):

    cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim .

2. Make sure the Phase 1.1 dev compose brings up `hermes-alice`. From repo root:

    cd deploy/docker && docker compose up -d hermes-alice

3. Verify it's up:

    curl -fsS -H "Authorization: Bearer $(cat deploy/docker/secrets/hermes_api_key_alice)" http://localhost:8643/health

## Running the tests

Requires three env vars:

- `OPENROUTER_API_KEY` — for the LLM call Hermes makes.
- `HERMES_TEST_URL` — default `http://localhost:8643`.
- `HERMES_TEST_KEY` — the bearer key from `deploy/docker/secrets/hermes_api_key_alice`.

Then:

    source scripts/env.sh
    export OPENROUTER_API_KEY=sk-or-v1-...
    export HERMES_TEST_KEY=$(cat deploy/docker/secrets/hermes_api_key_alice)
    bun run --filter @sentient/gateway test:int

Tests are `describe.skipIf(...)` — they skip cleanly if either env var is
missing, so `bun run ci` stays green without live API access.

## Teardown

    cd deploy/docker && docker compose down
