#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

winrm_pw="$(secrets packer_winrm_password)"

packer init .
packer validate \
  -var "proxmox_username=$(secrets proxmox_packer_username)" \
  -var "proxmox_token=$(secrets proxmox_packer_token)" \
  -var "winrm_password=${winrm_pw}" \
  -var "admin_password=${winrm_pw}" \
  -var-file=win11-tiny-cloudimg.pkrvars.hcl \
  "$@" .
