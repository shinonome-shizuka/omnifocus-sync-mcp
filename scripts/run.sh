#!/bin/bash
# 加载同目录 .env 后启动 omnifocus-sync-mcp stdio server
set -a
source "$(dirname "$0")/../.env"
set +a
# WebDAV host resolves a broken IPv6 address; force IPv4 first or fetch hangs.
export NODE_OPTIONS="--dns-result-order=ipv4first ${NODE_OPTIONS:-}"
exec node "$(dirname "$0")/../dist/index.js"
