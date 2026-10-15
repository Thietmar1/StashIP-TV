#!/bin/bash
# AGPLv3.0
# https://github.com/stashapp/CommunityScripts/blob/main/LICENSE

# builds a repository of plugins
# outputs to _site with the following structure:
# index.yml
# <plugin_id>.zip
# Each zip file contains the plugin.yml file and any other files in the same directory

outdir="$1"
if [ -z "$outdir" ]; then
    outdir="_site"
fi

rm -rf "$outdir"
mkdir -p "$outdir"

buildPlugin() 
{
    f=$1
    # get the plugin id from the directory
    dir=$(dirname "$f")
    plugin_id=$(basename "$f" .yml)

    echo "Processing $plugin_id"

    # create a directory for the version
    version=$(git log -n 1 --pretty=format:%h -- "$dir"/*)
    updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- "$dir"/*)
    
    # Plugins whose source needs bundling declare an npm "build" script; run it
    # so the zip picks up fresh artifacts. Fail loudly rather than shipping a
    # stale or missing bundle.
    if [ -f "$dir/package.json" ] && grep -q '"build"' "$dir/package.json"; then
        echo "  building $plugin_id"
        ( cd "$dir" && npm ci --silent && npm run build --silent ) || exit 1
    fi

    # create the zip file
    # copy other files
    zipfile=$(realpath "$outdir/$plugin_id.zip")
    
    pushd "$dir" > /dev/null
    find . -maxdepth 1 -type f \
        \( -name "*.yml" -o -name "*.js" -o -name "*.css" -o -name "*.py" -o -name "*.sh" \
           -o -name "IPTV.md" -o -name "tvguide-iptv.service" \) \
        ! -name "*.config.js" \
        | zip "$zipfile" -@ > /dev/null
    popd > /dev/null

    name=$(grep "^name:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
    description=$(grep "^description:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
    ymlVersion=$(grep "^version:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
    version="$ymlVersion-$version"
    dep=$(grep "^# requires:" "$f" | cut -c 12- | sed -e 's/\r//')

    # write to spec index
    echo "- id: $plugin_id
  name: $name
  metadata:
    description: $description
  version: $version
  date: $updated
  path: $plugin_id.zip
  sha256: $(sha256sum "$zipfile" | cut -d' ' -f1)" >> "$outdir"/index.yml

    # handle dependencies
    if [ ! -z "$dep" ]; then
        echo "  requires:" >> "$outdir"/index.yml
        for d in ${dep//,/ }; do
            echo "    - $d" >> "$outdir"/index.yml
        done
    fi

    echo "" >> "$outdir"/index.yml
}

# Prune node_modules and coverage before looking for plugin manifests. Both
# contain .yml files that are not plugins, and node_modules in particular is
# created by the build step above -- without the prune, a bundled plugin's
# dependencies would be picked up as plugins on the very same run.
find ./plugins -mindepth 1 \
    \( -name node_modules -o -name coverage -o -name .git \) -prune \
    -o -name '*.yml' -print | while read file; do
    buildPlugin "$file"
done
