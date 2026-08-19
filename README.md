# Surf Sim — Bells Beach

A real-life surfing simulator for mobile web, starting at **Bells Beach,
Torquay, Victoria** (home of the Rip Curl Pro). v1 is a visual simulation:
you float in the takeoff zone at the Bells Bowl while Southern Ocean
groundswell rolls in, shoals over the reef, and peels right — with the real
Bells terrain behind it, built from satellite imagery and elevation data.

## Try it

```bash
npm install
npm run dev        # then open on your phone (vite serves on your LAN)
npm run build      # production build in dist/ — any static host works
```

On a phone: drag to look around, pinch to zoom, tap **ENABLE TILT** to look
around by moving the phone (iOS asks for motion permission). On desktop:
drag with the mouse, scroll to zoom. Wait for a set — the **SET INCOMING**
badge pulses when one is about to roll through the lull.

Debug/query params: `?t0=25` starts the clock mid-set, `?fly=200` hoists the
camera for an aerial view, `?dbg=1..5` visualizes depth / foam / lighting /
reflection / normals, `?noocean=1` hides the water.

## How it's real

All map data is baked into `public/assets/` by `npm run fetch-assets`
(one-time; the app itself never touches the network):

- **Terrain** — a 6×6 km box centered on the Bells lineup, from AWS/Mapzen
  Terrain Tiles (z15 terrarium encoding), draped with a cloud-free
  **Sentinel-2** true-color scene (Dec 2024) from the AWS Open Data COG
  bucket. You can see the Winkipop headland, the beach, Jan Juc, and the
  Torquay township from the water.
- **Bathymetry** — open elevation data has no usable near-shore depths, so
  the seabed is synthesized from the real shoreline (distance transform)
  plus a tuned reef finger and channel anchored where the Bells Bowl
  actually breaks. Phantom "islands" in the coastal elevation data are
  detected by mainland flood-fill and dissolved.
- **Waves** — a Gerstner sum (3 swell components + wind chop) evaluated per
  vertex against the baked bathymetry: wavelength shortens and amplitude
  grows as depth drops (dispersion + Green's law), crests sharpen, and past
  the breaking index the wave spills into foam. Because the reef is
  shallower than the channel beside it, the break point travels along the
  crest — the peel. A set scheduler drives lulls and sets.
- **Camera** — floats on the same wave field (buoyancy + pitch), sitting in
  ~5 m of water beside the peak, found by walking the reef profile.

## Repo map

```
scripts/fetch-assets.mjs   asset baker (elevation, imagery, bathymetry, textures)
public/assets/             baked data + attribution metadata (assets.json)
src/ocean/                 Gerstner + shoaling vertex shader, water fragment
                           shader, wave-set scheduler
src/scene/                 terrain mesh + procedural sky/lighting
src/camera/                lineup camera (drag / pinch / device tilt)
src/ui/                    HUD (loading, set indicator, quality toggle)
```

## Roadmap

- Ride the wave: paddle, pop up, tilt-to-carve, wipeouts, scoring
- Live swell: drive the set scheduler from a surf forecast feed
- More breaks: Winkipop is one reef-finger definition away

## Data attribution

- Imagery: contains modified Copernicus Sentinel data 2024, processed by
  ESA / Element 84, via the AWS Open Data
  [Sentinel-2 COGs](https://registry.opendata.aws/sentinel-2-l2a-cogs/) bucket
- Elevation: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen / AWS Open Data), sourced from SRTM, Geoscience Australia et al.
