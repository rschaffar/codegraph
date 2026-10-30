{
  pkgs,
  nodejs,
  dependencies,
}:
pkgs.mkShell {
  packages = [
    nodejs
    pkgs.cargo
    pkgs.rustc
    pkgs.gitMinimal
    pkgs.zip
    pkgs.unzip
  ];
  shellHook = ''
    source ${
      pkgs.replaceVars ./dev-shell.sh {
        manifests = dependencies.manifests;
        modules = dependencies.development;
      }
    } || exit 1
  '';
}
