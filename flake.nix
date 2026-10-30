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

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          devShell = self.devShells.${system}.default;
          bootstrap = pkgs.writeShellScript "codegraph-dev-bootstrap" devShell.shellHook;
        in
        {
          codegraph = self.packages.${system}.codegraph;
          dev-shell =
            pkgs.runCommand "codegraph-dev-shell-check"
              {
                nativeBuildInputs = devShell.nativeBuildInputs;
              }
              ''
                mkdir -p checkout/ui wrong-directory
                install -m644 ${./package.json} checkout/package.json
                install -m644 ${./package-lock.json} checkout/package-lock.json
                install -m644 ${./ui/package.json} checkout/ui/package.json
                cd checkout
                sha256sum package.json package-lock.json ui/package.json > "$TMPDIR/manifests.sha256"

                ${bootstrap}
                node -e 'for (const name of ["typescript", "vitest", "svelte-check"]) require.resolve(name)'
                test -x ui/node_modules/.bin/vite
                test ! -e .codegraph

                # Re-entry must not reinstall an already complete dependency tree.
                touch -d @1 node_modules/.codegraph-nix-deps
                ${bootstrap}
                test "$(stat -c %Y node_modules/.codegraph-nix-deps)" = 1

                # A missing workspace tree must be recreated from the locked cache.
                rm -rf ui/node_modules
                ${bootstrap}
                test -x ui/node_modules/.bin/vite
                sha256sum --check "$TMPDIR/manifests.sha256"

                # Refuse unrelated directories and lock/cache mismatch before writes.
                if (cd ../wrong-directory; ${bootstrap}) > "$TMPDIR/wrong-directory.log" 2>&1; then
                  echo 'Bootstrap accepted an unrelated directory' >&2
                  exit 1
                fi
                grep -F 'Run nix develop from the CodeGraph checkout root.' "$TMPDIR/wrong-directory.log"
                printf '\n' >> package-lock.json
                if ${bootstrap} > "$TMPDIR/lock-mismatch.log" 2>&1; then
                  echo 'Bootstrap accepted a mismatched dependency lock' >&2
                  exit 1
                fi
                grep -F 'The checkout lockfile differs from the Nix npm cache' "$TMPDIR/lock-mismatch.log"
                test ! -e .codegraph
                if compgen -G "$TMPDIR/codegraph-npm.*" > /dev/null; then
                  echo 'Bootstrap left a temporary npm cache behind' >&2
                  exit 1
                fi
                touch "$out"
              '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          codegraph = self.packages.${system}.codegraph;
          nodejs = codegraph.nodejs;
          npmDeps = codegraph.npmDeps;
          rootName = (pkgs.lib.importJSON ./package.json).name;
          uiName = (pkgs.lib.importJSON ./ui/package.json).name;
        in
        {
          default = pkgs.mkShell {
            packages = [
              nodejs
              pkgs.cargo
              pkgs.rustc
              pkgs.gitMinimal
              # Release-archive regression fixtures used by npm test.
              pkgs.zip
              pkgs.unzip
            ];

            # Materialize mutable workspace dependencies from the same locked
            # cache as the package build; never use an ambient npm cache/network.
            shellHook = ''
              unset NIX_NODEJS_BUILDNPMPACKAGE
              _codegraphBootstrapNpm() (
                set -e -o pipefail
                if ! ${pkgs.lib.getExe nodejs} -e '
                  try {
                    const root = require("./package.json");
                    const ui = require("./ui/package.json");
                    process.exit(root.name === ${builtins.toJSON rootName} && ui.name === ${builtins.toJSON uiName} ? 0 : 1);
                  } catch { process.exit(1); }
                '; then
                  echo 'Run nix develop from the CodeGraph checkout root.' >&2
                  exit 1
                fi
                if ! cmp -s package-lock.json ${npmDeps}/package-lock.json; then
                  echo 'The checkout lockfile differs from the Nix npm cache; update npmDepsHash in nix/package.nix.' >&2
                  exit 1
                fi
                fingerprint=$(
                  {
                    printf '%s\n' '${npmDeps}' '${nodejs}' '${system}'
                    sha256sum package.json package-lock.json ui/package.json
                  } | sha256sum
                )
                installed=
                if test -f node_modules/.codegraph-nix-deps; then
                  IFS= read -r installed < node_modules/.codegraph-nix-deps || true
                fi
                if test "$installed" = "$fingerprint" \
                  && test -x node_modules/.bin/tsc \
                  && test -x node_modules/.bin/vitest \
                  && test -x ui/node_modules/.bin/vite; then
                  exit 0
                fi

                cache=$(mktemp -d "''${TMPDIR:-/tmp}/codegraph-npm.XXXXXXXX")
                trap 'rm -rf -- "$cache"' EXIT
                cp -R ${npmDeps}/. "$cache/"
                chmod -R u+w "$cache"
                echo 'Preparing locked CodeGraph npm dependencies offline…'
                npm_config_cache="$cache" npm_config_userconfig=/dev/null \
                  npm_config_update_notifier=false ${nodejs}/bin/npm ci \
                    --offline --ignore-scripts --include=dev --include=optional \
                    --workspaces --include-workspace-root --no-audit --no-fund
                test -x node_modules/.bin/tsc
                test -x node_modules/.bin/vitest
                test -x ui/node_modules/.bin/vite
                printf '%s\n' "$fingerprint" > node_modules/.codegraph-nix-deps
              )
              _codegraphBootstrapNpm
              _codegraphBootstrapStatus=$?
              unset -f _codegraphBootstrapNpm
              if test "$_codegraphBootstrapStatus" -ne 0; then
                exit "$_codegraphBootstrapStatus"
              fi
              unset _codegraphBootstrapStatus
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
