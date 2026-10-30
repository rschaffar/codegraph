{
  lib,
  nodejs,
  rustPlatform,
  stdenv,
  makeWrapper,
  dependencies,
}:
let
  manifest = lib.importJSON ../package.json;
  # Independent Cargo.lock build: no downloaded release runtime or rustup targets.
  kernel = rustPlatform.buildRustPackage {
    pname = "codegraph-kernel";
    version = (lib.importTOML ../codegraph-kernel/Cargo.toml).package.version;
    src = ../codegraph-kernel;
    cargoLock.lockFile = ../codegraph-kernel/Cargo.lock;
    # N-API symbols resolve in the Node host; installed smoke checks load it there.
    doCheck = false;
    installPhase = ''
      runHook preInstall
      install -Dm755 target/${stdenv.hostPlatform.rust.rustcTarget}/release/libcodegraph_kernel.so \
        "$out/lib/codegraph-kernel.node"
      runHook postInstall
    '';
  };
in
stdenv.mkDerivation {
  pname = "codegraph";
  version = manifest.version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../LICENSE
      ../package.json
      ../tsconfig.json
      ../src
      ../ui
      ../scripts/check-ui-build.mjs
    ];
  };
  nativeBuildInputs = [
    nodejs
    makeWrapper
  ];
  disallowedRequisites = [ dependencies.development ];
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home" npm_config_userconfig=/dev/null npm_config_offline=true
    mkdir -p "$HOME"
    cp -R ${dependencies.development}/node_modules ./node_modules
    cp -R ${dependencies.development}/ui/node_modules ./ui/node_modules
    chmod -R u+w node_modules ui/node_modules
    # Keep the UI's Vite 7 separate from the root's Vite 5 test tooling.
    substituteInPlace ui/package.json \
      --replace-fail '"build": "vite build"' '"build": "node node_modules/vite/bin/vite.js build"'
    patchShebangs ui/node_modules
    npm run build
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    packageRoot="$out/lib/codegraph"
    mkdir -p "$packageRoot/kernel"
    cp -r dist LICENSE package.json "$packageRoot/"
    ln -s ${dependencies.runtime}/node_modules "$packageRoot/node_modules"
    install -m755 ${kernel}/lib/codegraph-kernel.node "$packageRoot/kernel/"
    node scripts/check-ui-build.mjs --root "$packageRoot"
    makeWrapper ${lib.getExe nodejs} "$out/bin/codegraph" \
      --run 'export CODEGRAPH_HOST_PPID="''${CODEGRAPH_HOST_PPID:-$PPID}"' \
      --add-flags "--liftoff-only --disable-warning=ExperimentalWarning $packageRoot/dist/bin/codegraph.js"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/codegraph-home"
    export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache" XDG_DATA_HOME="$HOME/.local/share"
    export CODEGRAPH_TELEMETRY=0
    mkdir -p "$HOME"
    node --liftoff-only --disable-warning=ExperimentalWarning ${./smoke-test.cjs} "$out" ${lib.getExe nodejs}
    runHook postInstallCheck
  '';
  passthru = { inherit kernel nodejs dependencies; };
  meta = {
    description = "Local code intelligence CLI with browser visualization and native extraction";
    homepage = "https://github.com/colbymchenry/codegraph";
    license = lib.licenses.mit;
    mainProgram = "codegraph";
    platforms = lib.platforms.linux;
  };
}
