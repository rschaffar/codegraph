{
  description = "CodeGraph CLI, browser viewer and native extraction kernel";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      forSystems =
        f:
        nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
          system:
          let
            pkgs = import nixpkgs { inherit system; };
            nodejs = pkgs.nodejs_24;
            dependencies = pkgs.callPackage ./nix/dependencies.nix { inherit nodejs; };
            codegraph = pkgs.callPackage ./nix/package.nix { inherit nodejs dependencies; };
            devShell = import ./nix/dev-shell.nix { inherit pkgs nodejs dependencies; };
          in
          f {
            inherit
              pkgs
              nodejs
              dependencies
              codegraph
              devShell
              ;
          }
        );
    in
    {
      packages = forSystems (
        { codegraph, ... }: {
          inherit codegraph;
          default = codegraph;
        }
      );
      apps = forSystems (
        { pkgs, codegraph, ... }: {
          default = {
            type = "app";
            program = pkgs.lib.getExe codegraph;
          };
        }
      );
      devShells = forSystems (
        {
          pkgs,
          nodejs,
          devShell,
          ...
        }:
        {
          default = devShell;
          # Update manifests/lock without materializing or overwriting dependencies.
          update = pkgs.mkShell {
            packages = [
              nodejs
              pkgs.gitMinimal
            ];
          };
        }
      );
      checks = forSystems (
        {
          pkgs,
          nodejs,
          dependencies,
          codegraph,
          devShell,
        }:
        import ./nix/checks.nix {
          inherit
            pkgs
            nodejs
            dependencies
            codegraph
            devShell
            ;
          src = self;
        }
      );
      formatter = forSystems ({ pkgs, ... }: pkgs.nixfmt);
    };
}
