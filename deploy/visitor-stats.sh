#!/usr/bin/env bash
set -euo pipefail

echo "This legacy Nginx page-view counter is retired."
echo "The public page is now served directly by Caddy, while Nginx only handles allowlisted API traffic."
echo "Use the authenticated product analytics definition before publishing visitor counts."
exit 2
