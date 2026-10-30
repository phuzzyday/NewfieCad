"""Download the libraries NewfieCad uses into ./lib so it runs without internet.

Run once (python fetch_libs.py). Files already present are skipped; use --force to
download them again, for example after changing a version below.
"""

import pathlib
import sys
import urllib.request

CDN = 'https://cdn.jsdelivr.net/npm/'

# package@version -> files inside it (paths as published)
PACKAGES = {
    'three@0.185.0': ['build/three.module.js', 'build/three.core.js', 'LICENSE'],
    'replicad@1.1.0': ['dist/replicad.js', 'dist/casting-rs4QjB74.js', 'LICENSE'],
    'replicad-opencascadejs@1.1.0': ['dist/replicad_single.js', 'dist/replicad_single.wasm', 'LICENSE'],
    '@salusoft89/planegcs@1.3.0': [
        'dist/index.js',
        'dist/planegcs_dist/constraint_param_index.js',
        'dist/planegcs_dist/constraints.js',
        'dist/planegcs_dist/enums.js',
        'dist/planegcs_dist/gcs_system.js',
        'dist/planegcs_dist/gcs_system_mock.js',
        'dist/planegcs_dist/id.js',
        'dist/planegcs_dist/planegcs.js',
        'dist/planegcs_dist/planegcs.wasm',
        'dist/sketch/emsc_vectors.js',
        'dist/sketch/gcs_wrapper.js',
        'dist/sketch/geom_params.js',
        'dist/sketch/sketch_index.js',
        'dist/sketch/sketch_primitive.js',
        'LICENSE',
    ],
}

LIB = pathlib.Path(__file__).resolve().parent / 'lib'


def folder(pkg):
    # lib/three, lib/replicad, lib/replicad-opencascadejs, lib/planegcs
    return LIB / pkg.rsplit('@', 1)[0].split('/')[-1]


def main():
    force = '--force' in sys.argv
    total = 0
    for pkg, files in PACKAGES.items():
        for name in files:
            dest = folder(pkg) / name
            if dest.exists() and not force:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            url = f'{CDN}{pkg}/{name}'
            print(f'  {url}')
            with urllib.request.urlopen(url) as resp:
                data = resp.read()
            dest.write_bytes(data)
            total += len(data)
    print(f'Done: {total / 1e6:.1f} MB downloaded into {LIB}')


if __name__ == '__main__':
    main()
