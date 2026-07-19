#!/usr/bin/env bash
# Deploy VMs: resolves secrets -> TF_VAR_* env -> terraform.
# Secrets resolve via repo-root secrets.conf (see secrets.conf.example);
# `secrets` and `terraform` come from the nix dev shell (`nix develop`).
# Usage: ./run_terraform.sh [plan|apply|destroy]
set -euo pipefail
cd "$(dirname "$0")"

action="${1:-plan}"
config="${CONFIG:-vms.auto.tfvars.json}"

[ -f "$config" ] || { echo "config not found: $config (copy examples/vms.tfvars.json, or CONFIG=examples/vms.tfvars.json)" >&2; exit 1; }

# Note: assign before export -- `export VAR="$(cmd)"` would swallow cmd's
# exit status and defeat set -e.
TF_VAR_proxmox_endpoint="$(secrets proxmox_endpoint)"
TF_VAR_proxmox_user_name="$(secrets proxmox_user_name)"
TF_VAR_proxmox_user_password="$(secrets proxmox_user_password)"
export TF_VAR_proxmox_endpoint TF_VAR_proxmox_user_name TF_VAR_proxmox_user_password
# Netbird key is optional in secrets.conf; fall back to the tfvars file if absent.
if key="$(secrets netbird_setup_key 2>/dev/null)"; then
  export TF_VAR_netbird_setup_key="$key"
fi
# Optional: pre-provisioned Sunshine Web UI credential.
if sunpass="$(secrets sunshine_admin_password 2>/dev/null)"; then
  export TF_VAR_sunshine_admin_password="$sunpass"
fi

terraform init -input=false

case "$action" in
  plan)
    terraform plan -var-file="$config"
    ;;
  apply)
    terraform apply -var-file="$config"
    ;;
  destroy)
    terraform destroy -var-file="$config"
    ;;
  *)
    echo "usage: $0 [plan|apply|destroy]" >&2
    exit 2
    ;;
esac
