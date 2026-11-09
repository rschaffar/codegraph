# Sourced by nix develop. Dependencies are already built by Nix, not installed here.
# Physical copies preserve editable workspace links and writable tool caches.
_codegraphPrepareModules() {
  local source target parent stage current
  if [ -L ui ] || ! cmp -s package.json @manifests@/package.json ||
     ! cmp -s package-lock.json @manifests@/package-lock.json ||
     ! cmp -s ui/package.json @manifests@/ui/package.json; then
    echo 'Run nix develop from the CodeGraph root with matching root/UI manifests and lockfile.' >&2
    return 1
  fi
  # Validate both destinations before creating either one. Never replace unknown
  # dependencies, old generations or symlinks merely to make shell entry work.
  for target in node_modules ui/node_modules; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      current=
      if [ ! -L "$target" ] && [ -d "$target" ] && [ ! -L "$target/.codegraph-nix-modules" ] && [ -f "$target/.codegraph-nix-modules" ]; then
        IFS= read -r current < "$target/.codegraph-nix-modules" || return 1
      fi
      if [ "$current" != '@modules@' ]; then
        echo "CodeGraph dependencies at $PWD/$target are not this Nix generation; move them aside explicitly before re-entering." >&2
        return 1
      fi
    fi
  done
  for target in node_modules ui/node_modules; do
    [ -d "$target" ] && continue
    parent=$(dirname "$target")
    source='@modules@'/$target
    stage=$(mktemp -d "$parent/.codegraph-node-modules.XXXXXXXX") || return 1
    if ! cp -a --no-preserve=ownership --reflink=auto "$source/." "$stage/" ||
       ! chmod -R u+w "$stage" ||
       ! printf '%s\n' '@modules@' > "$stage/.codegraph-nix-modules"; then
      echo "Dependency preparation failed; staged files remain at $PWD/$stage." >&2
      return 1
    fi
    if [ -e "$target" ] || [ -L "$target" ] || ! mv -T --no-clobber "$stage" "$target" || [ -e "$stage" ]; then
      echo "Dependency destination changed; staged files remain at $PWD/$stage." >&2
      return 1
    fi
  done
  if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/vitest ] ||
     { [ ! -x ui/node_modules/.bin/vite ] && [ ! -x node_modules/.bin/vite ]; } ||
     [ "$(readlink -f node_modules/@colbymchenry/codegraph-ui)" != "$(pwd -P)/ui" ]; then
    echo 'CodeGraph Nix dependencies are incomplete or the UI workspace link is not local; move the affected tree aside explicitly.' >&2
    return 1
  fi
}
if ! _codegraphPrepareModules; then
  unset -f _codegraphPrepareModules
  return 1
fi
unset -f _codegraphPrepareModules
unset NIX_NODEJS_BUILDNPMPACKAGE
export PATH="$PWD/node_modules/.bin:$PWD/ui/node_modules/.bin:$PATH"
