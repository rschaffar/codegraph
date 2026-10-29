{
  description = "CodeGraph CLI, browser viewer and native extraction kernel";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          codegraph = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit codegraph;
          default = codegraph;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.codegraph;
          meta.description = "Run CodeGraph with the browser viewer and native extraction kernel";
        };
      });

      checks = forAllSystems (system: {
        codegraph = self.packages.${system}.codegraph;
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.cargo
              pkgs.rustc
            ];
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
