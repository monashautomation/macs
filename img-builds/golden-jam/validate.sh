#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

packer init .
packer validate \
  -var "proxmox_username=$(secrets proxmox_packer_username)" \
  -var "proxmox_token=$(secrets proxmox_packer_token)" \
  -var-file=golden-jam.pkrvars.hcl \
  "$@" .

