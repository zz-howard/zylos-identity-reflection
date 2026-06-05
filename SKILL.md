---
name: identity-reflection
version: 0.1.0
description: >
  Periodic self-reflection component for zylos agents. Use when ...
  (Include trigger patterns: what user requests should activate this component)
type: utility  # communication | capability | utility

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-identity-reflection
    entry: src/index.js
  data_dir: ~/zylos/components/identity-reflection
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - data/

# For HTTP services exposed through Zylos Caddy, prefer a root-internal app:
# - The component listens on localhost and serves internal routes at /.
# - Caddy exposes it at /identity-reflection/*, strips that prefix, and forwards
#   X-Forwarded-Prefix. Browser URLs should be relative by default and should
#   use X-Forwarded-Prefix when present.
# http_routes:
#   - path: /identity-reflection/*
#     type: reverse_proxy
#     target: localhost:3000
#     strip_prefix: /identity-reflection

upgrade:
  repo: zylos-ai/zylos-identity-reflection
  branch: main

config:
  required:
    # - name: IDENTITY_REFLECTION_API_KEY
    #   description: API key for identity-reflection
    #   sensitive: true
  optional:
    # - name: IDENTITY_REFLECTION_DEBUG
    #   description: Enable debug mode
    #   default: "false"

dependencies: []
---

# Identity Reflection

```bash
# Example usage commands here
```

Run `node ~/zylos/.claude/skills/identity-reflection/scripts/<script>.js --help` for all options.
