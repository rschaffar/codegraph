{
  lib,
  importNpmLock,
  nodejs,
}:
let
  # Application edits must not invalidate the installed dependency derivation.
  manifests = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../ui/package.json
    ];
  };
  package = lib.importJSON (manifests + "/package.json");
  packageLock = lib.importJSON (manifests + "/package-lock.json");
  uiPackage = lib.importJSON (manifests + "/ui/package.json");
  # Detach the unshipped UI workspace, not arbitrary !dev lock entries: some UI
  # dependencies are regular dependencies and must not enter the CLI closure.
  runtimeLock = packageLock // {
    packages =
      (lib.filterAttrs (
        path: _: path != "ui" && !(lib.hasPrefix "ui/" path) && path != "node_modules/${uiPackage.name}"
      ) packageLock.packages)
      // {
        "" = builtins.removeAttrs packageLock.packages."" [ "workspaces" ];
      };
  };
  runtime = importNpmLock.buildNodeModules {
    inherit nodejs;
    package = builtins.removeAttrs package [ "workspaces" ];
    packageLock = runtimeLock;
    derivationArgs = {
      pname = "codegraph-runtime-modules";
      npmInstallFlags = [ "--omit=dev" ];
      npmRebuildFlags = [ "--ignore-scripts" ];
      # npm's unused install cache embeds tarball store references. Remove only
      # that metadata, not package payloads, WASM assets or optional dependencies.
      postInstall = ''rm -f "$out/node_modules/.package-lock.json"'';
    };
  };
  development = importNpmLock.buildNodeModules {
    npmRoot = manifests;
    inherit nodejs;
    derivationArgs = {
      pname = "codegraph-development-modules";
      npmRebuildFlags = [ "--ignore-scripts" ];
      # The convenience builder stages only root metadata by default.
      postPatch = ''
        mkdir -p ui
        cp ${manifests}/ui/package.json ui/package.json
      '';
      installPhase = ''
        runHook preInstall
        mkdir -p "$out/ui"
        cp package.json package-lock.json "$out/"
        cp ui/package.json "$out/ui/"
        mv node_modules "$out/"
        # npm may hoist every workspace dependency into the root tree.
        # Keep a physical workspace destination for the guarded shell workflow.
        mkdir -p ui/node_modules
        mv ui/node_modules "$out/ui/"
        runHook postInstall
      '';
    };
  };
in
{
  inherit manifests development runtime;
}
