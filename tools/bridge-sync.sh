#!/bin/bash
# La webapp servita dal punto d'incontro deve essere **la stessa** che serve il
# Mac: qui si copia, invece di tenerne due copie che divergono.
#
# Resta fuori solo la pagina ponte (`host-bridge.*`): quella gira dentro il Mac
# e non ha niente da fare su un server pubblico.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/webapp"
DST="$ROOT/bridge/public"

mkdir -p "$DST"
rm -f "$DST"/*
for f in "$SRC"/*; do
  name="$(basename "$f")"
  case "$name" in
    host-bridge.*) continue ;;
  esac
  cp "$f" "$DST/$name"
done

echo "webapp copiata nel punto d'incontro:"
ls -1 "$DST" | sed 's/^/  /'
