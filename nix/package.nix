{
  lib,
  buildNpmPackage,
  nodejs_24,
  rustPlatform,
  stdenv,
  makeWrapper,
}:
let
  manifest = lib.importJSON ../package.json;

  # Build the addon directly, without the release scripts' rustup target
  # management or downloaded Node runtime.
  kernel = rustPlatform.buildRustPackage {
    pname = "codegraph-kernel";
    version = (lib.importTOML ../codegraph-kernel/Cargo.toml).package.version;
    src = ../codegraph-kernel;
    cargoLock.lockFile = ../codegraph-kernel/Cargo.lock;

    # This cdylib resolves N-API symbols in the Node host. The package's
    # install check loads and exercises it there, rather than as a Rust test binary.
    doCheck = false;
    installPhase = ''
      runHook preInstall
      install -Dm755 target/${stdenv.hostPlatform.rust.rustcTarget}/release/libcodegraph_kernel.so \
        "$out/lib/codegraph-kernel.node"
      runHook postInstall
    '';
  };
in
buildNpmPackage {
  pname = "codegraph";
  version = manifest.version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../LICENSE
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../src
      ../ui
      ../scripts/check-ui-build.mjs
    ];
  };

  nodejs = nodejs_24;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-QA28P/ek+55IO4AkZFVm8sd8uyxjKlUuCFnF6XFLTzA=";
  npmFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ makeWrapper ];

  # Select the workspace's locked Vite explicitly: npm's build-time PATH picks
  # the root's Vite 5 (test tooling), incompatible with the UI's Vite 7 plugin.
  # Keep the upstream build pipeline otherwise unchanged.
  preBuild = ''
    substituteInPlace ui/package.json \
      --replace-fail '"build": "vite build"' '"build": "node node_modules/vite/bin/vite.js build"'
    patchShebangs ui/node_modules
  '';

  # npm run build includes the standalone viewer, schema and vendored grammars.
  # Do not run build:lib: the private reusable UI package is not needed here.
  installPhase = ''
    runHook preInstall
    packageRoot="$out/lib/codegraph"
    mkdir -p "$packageRoot/kernel"
    cp -r dist LICENSE package.json package-lock.json "$packageRoot/"

    # Match the release layout: runtime dependencies only, without a dangling
    # link to the source-only ui workspace. All downloads were prefetched.
    npm ci --prefix "$packageRoot" --omit=dev --ignore-scripts --offline
    rm "$packageRoot/package-lock.json"
    install -m755 ${kernel}/lib/codegraph-kernel.node "$packageRoot/kernel/"
    node scripts/check-ui-build.mjs --root "$packageRoot"

    # Preserve the MCP host pid across the launcher, as the release bundle does.
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/codegraph" \
      --run 'export CODEGRAPH_HOST_PPID="''${CODEGRAPH_HOST_PPID:-$PPID}"' \
      --add-flags "--liftoff-only --disable-warning=ExperimentalWarning $packageRoot/dist/bin/codegraph.js"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/codegraph-home"
    export XDG_CONFIG_HOME="$HOME/.config"
    export XDG_CACHE_HOME="$HOME/.cache"
    export XDG_DATA_HOME="$HOME/.local/share"
    export CODEGRAPH_TELEMETRY=0
    mkdir -p "$HOME"
    node --liftoff-only --disable-warning=ExperimentalWarning ${./smoke-test.cjs} "$out" ${lib.getExe nodejs_24}
    runHook postInstallCheck
  '';

  passthru = { inherit kernel; };

  meta = {
    description = "Local code intelligence CLI with browser visualization and native extraction";
    homepage = "https://github.com/colbymchenry/codegraph";
    license = lib.licenses.mit;
    mainProgram = "codegraph";
    platforms = lib.platforms.linux;
  };
}
