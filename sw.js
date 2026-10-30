// Offline support for the installed app. Everything is saved when the app is installed
// (or first opened). App files are fetched fresh when online, so updates show up, and
// served from the saved copy when offline. Library files never change for a given
// version, so they are served from the saved copy straight away.
//
// When you add an app file, list it here. When you change a library version in
// fetch_libs.py, update its files below and bump LIB_CACHE.

const APP_CACHE = 'newfiecad-app';
const LIB_CACHE = 'newfiecad-lib-1';

const APP_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'css/app.css',
  ...['features', 'geom2d', 'gizmo', 'icons', 'io', 'kernel-worker', 'kernel', 'main', 'outline', 'profiles', 'select',
    'shape-drag', 'simplify-worker', 'simplify', 'sketch-labels', 'sketch-model', 'sketch-tools', 'sketch', 'solver', 'stl',
    'timeline', 'tree', 'ui', 'viewcube', 'viewport'].map((n) => `js/${n}.js`),
];

const LIB_FILES = [
  'lib/three/build/three.module.js', 'lib/three/build/three.core.js',
  'lib/replicad/dist/replicad.js', 'lib/replicad/dist/casting-rs4QjB74.js',
  'lib/replicad-opencascadejs/dist/replicad_single.js', 'lib/replicad-opencascadejs/dist/replicad_single.wasm',
  ...['index', 'planegcs_dist/constraint_param_index', 'planegcs_dist/constraints', 'planegcs_dist/enums',
    'planegcs_dist/gcs_system', 'planegcs_dist/gcs_system_mock', 'planegcs_dist/id', 'planegcs_dist/planegcs',
    'sketch/emsc_vectors', 'sketch/gcs_wrapper', 'sketch/geom_params', 'sketch/sketch_index', 'sketch/sketch_primitive',
  ].map((n) => `lib/planegcs/dist/${n}.js`),
  'lib/planegcs/dist/planegcs_dist/planegcs.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await (await caches.open(APP_CACHE)).addAll(APP_FILES);
    await (await caches.open(LIB_CACHE)).addAll(LIB_FILES);
    await self.skipWaiting();
  })());
});

// Drop library caches from older versions.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== APP_CACHE && key !== LIB_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const isLib = new URL(req.url).pathname.includes('/lib/');
  event.respondWith(isLib ? libFirst(req) : networkFirst(req));
});

async function libFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(LIB_CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(APP_CACHE)).put(req, res.clone());
    return res;
  } catch {
    // Offline: the saved copy (pages fall back to the app's start page).
    return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await caches.match('./'))) || Response.error();
  }
}
