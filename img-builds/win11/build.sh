#!/usr/bin/env bash
# Build the win11-tiny golden image template on Proxmox.
# Secrets resolve via repo-root secrets.conf (see secrets.conf.example).
set -euo pipefail
cd "$(dirname "$0")"

winrm_pw="$(secrets packer_winrm_password)"

packer init .
packer build \
  -var "proxmox_username=$(secrets proxmox_packer_username)" \
  -var "proxmox_token=$(secrets proxmox_packer_token)" \
  -var "winrm_password=${winrm_pw}" \
  -var "admin_password=${winrm_pw}" \
  -var-file=win11-tiny-cloudimg.pkrvars.hcl \
  "$@" .
