# Native stack QA helpers

`apply-addons.ts` exercises the real system orchestrator against selected local
managed services. It is local-only and may mutate the local Docker stack.

```bash
source scripts/env.sh
HOST_CONFIG_DIR="$HOME/.sentient/gateway/config" \
  bun qa/native/apply-addons.ts egress-proxy searxng ingress-proxy outbound-worker
```

Network confinement and route contracts are pinned in
`gateway/src/system-orchestrator/addon-confinement.test.ts`. Production
verification remains observational-only unless separately authorized.
