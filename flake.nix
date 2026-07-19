{
  description = "Proxmox VM provisioner dev shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.11";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs { inherit system; config.allowUnfree = true; }));
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bashInteractive
            pkgs.terraform
            pkgs.packer
          ];
        shellHook = ''
          export PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/scripts:$PATH"
        '';

        };
      });
    };
}
