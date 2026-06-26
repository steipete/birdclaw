{
  description = "A Nix-flake-based Node.js development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, ... }@inputs:

    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forEachSupportedSystem =
        f:
        inputs.nixpkgs.lib.genAttrs supportedSystems (
          system:
          f {
            inherit system;
            pkgs = import inputs.nixpkgs {
              inherit system;
              overlays = [ self.overlays.default ];
            };
          }
        );
    in
    {
      overlays.default = final: prev: rec {
        nodejs = prev.nodejs;
        yarn = (prev.yarn.override { inherit nodejs; });
        birdclaw = self.packages.${final.system}.birdclaw;
      };

      packages = forEachSupportedSystem (
        { system, ... }:
        let
          basePkgs = import inputs.nixpkgs { inherit system; };
        in
        {
          default = self.packages.${system}.birdclaw;
          birdclaw = basePkgs.callPackage ./nix/package.nix {
            src = self;
          };
        }
      );

      devShells = forEachSupportedSystem (
        { pkgs, system }:
        {
          default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nodejs
              pnpm
              yarn
              zip
              unzip
              self.formatter.${system}
            ];
          };
        }
      );

      formatter = forEachSupportedSystem ({ pkgs, ... }: pkgs.nixfmt);

      nixosModules = {
        birdclaw = import ./nix/birdclaw.nix;
      };
    };
}
