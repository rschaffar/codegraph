{
  pkgs,
  nodejs,
  dependencies,
  codegraph,
  devShell,
  src,
}:
let
  prepare = pkgs.writeShellScript "codegraph-prepare-modules" devShell.shellHook;
  tools = [
    nodejs
    pkgs.gitMinimal
    pkgs.zip
    pkgs.unzip
    pkgs.openssl # Local HTTPS/checksum fixtures in npm-shim.test.ts.
  ];
in
{
  inherit codegraph;
  runtime = pkgs.runCommand "codegraph-runtime-modules-check" { nativeBuildInputs = [ nodejs ]; } ''
    node <<'NODE'
    const fs=require('fs'), assert=require('assert/strict'), path=require('path');
    const root='${dependencies.runtime}/node_modules';
    const manifest=require('${dependencies.manifests}/package.json');
    const lock=require('${dependencies.manifests}/package-lock.json');
    for(const name of Object.keys(manifest.dependencies)) {
      const actual=JSON.parse(fs.readFileSync(path.join(root,name,'package.json')));
      assert.equal(actual.version,lock.packages['node_modules/'+name].version,name);
    }
    for(const name of ['typescript','vitest','vite','svelte','@xyflow','@colbymchenry/codegraph-ui','.package-lock.json'])
      assert.equal(fs.existsSync(path.join(root,name)),false,name);
    NODE
    touch "$out"
  '';
  dev-shell = pkgs.runCommand "codegraph-dev-shell-check" { nativeBuildInputs = tools; } ''
    mkdir -p checkout/ui wrong-directory fake-bin
    cp ${dependencies.manifests}/package{,-lock}.json checkout/
    cp ${dependencies.manifests}/ui/package.json checkout/ui/
    chmod u+w checkout/package{,-lock}.json checkout/ui/package.json
    printf '#!${pkgs.runtimeShell}\necho "shell entry must not invoke npm" >&2\nexit 73\n' > fake-bin/npm
    chmod +x fake-bin/npm
    export PATH="$PWD/fake-bin:$PATH"
    cd checkout
    sha256sum package.json package-lock.json ui/package.json > "$TMPDIR/manifests.sha256"
    ${prepare}
    node -e 'const a=require("assert");const l=require("./package-lock.json");a.equal(require("./node_modules/vite/package.json").version,l.packages["node_modules/vite"].version);a.equal(require("./ui/node_modules/vite/package.json").version,l.packages["ui/node_modules/vite"].version);require.resolve("svelte-check");a.equal(require("fs").realpathSync("node_modules/@colbymchenry/codegraph-ui"),process.cwd()+"/ui")'
    test ! -e .codegraph
    touch -d @1 node_modules/.codegraph-nix-modules
    ${prepare}
    test "$(stat -c %Y node_modules/.codegraph-nix-modules)" = 1
    rm -rf ui/node_modules
    ${prepare}
    test -x ui/node_modules/.bin/vite
    sha256sum --check "$TMPDIR/manifests.sha256"
    # Logical checkout aliases must still resolve the UI to this physical tree.
    (cd ..; ln -s checkout checkout-alias; cd checkout-alias; ${prepare})

    if (cd ../wrong-directory; ${prepare}) > "$TMPDIR/wrong.log" 2>&1; then exit 1; fi
    grep -F 'matching root/UI manifests and lockfile' "$TMPDIR/wrong.log"
    printf '\n' >> package-lock.json
    if ${prepare} > "$TMPDIR/mismatch.log" 2>&1; then exit 1; fi
    grep -F 'matching root/UI manifests and lockfile' "$TMPDIR/mismatch.log"
    cp ${dependencies.manifests}/package-lock.json .
    # Unknown and symlinked dependencies must survive refusals unchanged.
    mv node_modules node_modules.saved
    mkdir node_modules
    printf 'user owned' > node_modules/keep
    if ${prepare} > "$TMPDIR/unknown.log" 2>&1; then exit 1; fi
    test "$(<node_modules/keep)" = 'user owned'
    mv node_modules unknown-modules
    ln -s node_modules.saved node_modules
    if ${prepare} > "$TMPDIR/symlink.log" 2>&1; then exit 1; fi
    test -L node_modules
    test ! -e .codegraph
    touch "$out"
  '';

  unit = pkgs.stdenvNoCC.mkDerivation {
    pname = "codegraph-unit-check";
    version = codegraph.version;
    inherit src;
    nativeBuildInputs = tools;
    postPatch = ''
      cp -R ${dependencies.development}/node_modules ./node_modules
      cp -R ${dependencies.development}/ui/node_modules ./ui/node_modules
      chmod -R u+w node_modules ui/node_modules
      substituteInPlace ui/package.json --replace-fail '"build": "vite build"' '"build": "node node_modules/vite/bin/vite.js build"'
    '';
    buildPhase = ''
      export HOME="$TMPDIR/home" TERM=xterm-256color
      export npm_config_userconfig=/dev/null npm_config_offline=true npm_config_update_notifier=false
      mkdir -p "$HOME"
      # Exercise the existing real-repository API regression too. This index is
      # confined to the builder's disposable source, never the caller checkout.
      CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_PROMPT_HOOK=1 ${pkgs.lib.getExe codegraph} init
      npm test
      npm run check --workspace ui
      npm run build:lib
    '';
    installPhase = ''touch "$out"'';
  };
}
