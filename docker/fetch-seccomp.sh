#!/usr/bin/env sh
# Jalankan di VPS (bukan laptop). Mengunduh profil seccomp resmi Playwright yang mengizinkan
# syscall yang dibutuhkan sandbox Chromium (clone/unshare user namespace), supaya Chromium bisa
# berjalan DENGAN sandbox di dalam container.
set -eu
cd "$(dirname "$0")"
curl -fsSL -o seccomp_profile.json \
  https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json
echo "ok: docker/seccomp_profile.json"
