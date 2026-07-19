# terraform

Provisions Proxmox VMs, cloning the golden-image templates built from
[`../img-builds`](../img-builds).

## Layout

```
run_terraform.sh        secrets -> TF_VAR_* -> terraform plan/apply/destroy
main.tf                 cloud-image download + per-VM module instances
variables.tf            all root inputs (network, templates, vms, ...)
vms.auto.tfvars.json    active VM/network config (see examples/)
modules/vm/             one VM: clone or cloud image, cloud-init snippet
id_rsa.pub              SSH public key installed on every Linux VM
```

## VM paths

Each entry in `vms` either clones a Packer template or boots the stock
Ubuntu cloud image:

- **`template` set** — full-clone of a golden image. The key must exist in
  `templates`, whose `vm_id` matches the `vm_id` in the corresponding
  `img-builds/*/*.pkrvars.hcl` (`golden-jam` = 9000, `win11-tiny` = 9001,
  `os = "windows"`). Desktop, Sunshine, drivers etc. are baked into the
  image; deploy time only joins NetBird and does per-VM Sunshine config
  (CSRF origins, optional web UI credential).
- **`template` omitted** — plain Ubuntu 22.04 server VM from the upstream
  cloud image (downloaded per node); cloud-init installs the guest agent
  and joins NetBird. For utility VMs that don't need the golden image.

The Linux golden image's baked-in user is `baker` (`template_user`); an
additional `vm_user` with the `id_rsa.pub` key is created on every VM.

## Usage

From the repo root, inside the dev shell (`nix develop`), with
`secrets.conf` populated (see `secrets.conf.example`):

```sh
cd terraform
./run_terraform.sh plan     # default
./run_terraform.sh apply
./run_terraform.sh destroy
```

`CONFIG=examples/vms.tfvars.json ./run_terraform.sh plan` selects an
alternate VM config.
