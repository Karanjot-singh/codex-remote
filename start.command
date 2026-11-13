#!/bin/zsh
set -eu
cd "${0:A:h}"
node control.mjs status
exec node server.mjs
