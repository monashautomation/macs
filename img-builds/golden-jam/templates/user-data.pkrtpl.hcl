#cloud-config
autoinstall:
  version: 1
  identity:
    hostname: template
    username: baker
    password: "!"  # locked; SSH key auth only
  ssh:
    install-server: true
    allow-pw: false
    ssh-quiet-keygen: true
    authorized-keys:
      - "${ssh_public_key}"
  source:
    id: ubuntu-server
  packages:
    - pkgconf
    - wget
    - curl
    - unzip
    - git
    - build-essential
    - openssh-server
    - cloud-init
    - net-tools
    - qemu-guest-agent
  late-commands:
    - curtin in-target --target=/target -- apt update
    - curtin in-target --target=/target -- systemctl enable qemu-guest-agent
    - curtin in-target --target=/target -- systemctl start qemu-guest-agent || true
    - systemctl enable ssh
    - curtin in-target --target=/target -- sed -i -e 's/GRUB_CMDLINE_LINUX=""/GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"/g' /etc/default/grub
  mirrors:
    ubuntu-archive: ${apt_mirror_url}
%{ if apt_cacher_url != "" ~}
  proxy: ${apt_cacher_url}
%{ endif ~}
  grub:
    reorder_uefi: false
  user-data:
    package_upgrade: false
    timezone: Australia/Melbourne

system_info:
  default_user:
    name: baker

