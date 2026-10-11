# SuperSplat Editor

[![Github Release](https://img.shields.io/github/v/release/playcanvas/supersplat)](https://github.com/playcanvas/supersplat/releases)
[![License](https://img.shields.io/github/license/playcanvas/supersplat)](https://github.com/playcanvas/supersplat/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-5865F2?style=flat&logo=discord&logoColor=white&color=black)](https://discord.gg/T3pnhRTTAY)
[![Reddit](https://img.shields.io/badge/Reddit-FF4500?style=flat&logo=reddit&logoColor=white&color=black)](https://www.reddit.com/r/PlayCanvas)
[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white&color=black)](https://x.com/intent/follow?screen_name=playcanvas)

| [SuperSplat Editor](https://superspl.at/editor) | [User Guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/supersplat/) | [Blog](https://blog.playcanvas.com) | [Forum](https://forum.playcanvas.com) |

The SuperSplat Editor is a free and open source tool for inspecting, editing, optimizing and publishing 3D Gaussian Splats. It is built on web technologies and runs in the browser, so there's nothing to download or install.

A live version of this tool is available at: https://superspl.at/editor

![image](https://github.com/user-attachments/assets/b6cbb5cc-d3cc-4385-8c71-ab2807fd4fba)

To learn more about using SuperSplat, please refer to the [User Guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/supersplat/).

## Local Development

To initialize a local development environment for SuperSplat, ensure you have [Node.js](https://nodejs.org/) 20.19 or later installed. Follow these steps:

1. Clone the repository:

   ```sh
   git clone https://github.com/playcanvas/supersplat.git
   cd supersplat
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Build SuperSplat and start a local web server:

   ```sh
   npm run develop
   ```

4. Open a web browser tab and make sure network caching is disabled on the network tab and the other application caches are clear:

   - On Safari you can use `Cmd+Option+e` or Develop->Empty Caches.
5. Navigate to `http://localhost:3000`

When changes to the source are detected, SuperSplat is rebuilt automatically. Simply refresh your browser to see your changes.

## Embedding the editor in an iframe

A page that embeds the editor in an `<iframe>` can drive it with `postMessage`. Every request is an object with a
`type` and an optional `id`; the reply carries the same `type` and `id` and a `result`. Requests that change the
scene or hand data out are answered only when they come from the embedding page (`window.parent`) at its own origin.
A failed request answers `{ ok: false, error }`; the error starts with a code such as `HOST_LAYER_UNKNOWN`.

The API has a version (`HOST_API_VERSION` in `src/host/frame.ts`, now **2**). `supersplat:ready` carries it as
`apiVersion`, and `supersplat:host-info` answers it with the list of requests this build takes. Version 1 was
`import`, `scene-stats` and `export`; version 2 adds layers, the camera, the background, clip volumes and events.
The code is `src/iframe-api.ts` (messages) and `src/host/` (`frame.ts`: checking and arithmetic, no engine import;
`layers.ts`: the layers; `backdrop.ts`: the background). `bun test test` runs the tests of the pure part.

### Version 1: one file in, statistics, an export out

| Message | Direction | Fields | Result |
| --- | --- | --- | --- |
| `supersplat:ready` | editor to host | `apiVersion` | Sent once when the editor can take requests. |
| `supersplat:is-scene-dirty` | host to editor | none | `boolean`: the scene has unsaved changes. |
| `supersplat:navigate-home` | editor to host | none | The menubar logo was clicked; the host owns navigation. |
| `supersplat:host-info` | host to editor | none | `{ ok, apiVersion, requests: string[], exportTypes: string[], upAxis }`. |
| `supersplat:import` | host to editor | `url`, `filename` (optional when the URL ends in one) | `{ ok, filename, imported: string[], stats }`. Loads the file exactly as the `?load=` URL parameter does. |
| `supersplat:scene-stats` | host to editor | none | `{ dirty, documentName, selection, splats: [{ name, filename, visible, numSplats, numSelected, numLocked, numDeleted }] }`. |
| `supersplat:export` | host to editor | `fileType` (`ply`, `compressedPly`, `splat`, `sog`, `spz`), `filename` (optional), `maxSHBands` (optional, 0 to 3) | `{ ok, filename, fileType, byteLength, data: ArrayBuffer }`. The visible splats, written with the editor's own writers; the buffer is transferred, not copied. |
| `supersplat:show-export` | host to editor | `exportType` (`ply`, `splat`, `sog`, `spz`, `viewer`) | `{ ok, exportType }`. Opens the editor's own export dialog (File > Export) with every option it carries: compression, spherical-harmonic bands, SOG iterations, SPZ version, the HTML or ZIP viewer with its start pose, animation and background colour. Answers when the dialog opens; the person finishes it. (Since version 2.) |

### Version 2: the host's layers

A host that keeps a list of splat files (a manifest) sends its rows and the editor makes each one a scene element:
an ordinary editor layer, listed in the Scene Manager, that can be selected, erased, transformed, graded and
exported like any other. The host refers to it by the `id` it chose.

| Message | Fields | Result |
| --- | --- | --- |
| `supersplat:load-layers` | `layers: [...]`, `upAxis` (`'y'` or `'z'`), `replace` (optional: remove the host's earlier layers first), `wait` (default true: answer when the visible layers are in the scene), `frame` (default true: frame the scene afterwards) | `{ ok, upAxis, layers: Layer[], skipped: [{ id, kind, reason }], clipVolumes, background }` |
| `supersplat:set-layer-visible` | `layerId`, `visible` | `{ ok, layer: Layer }`. Showing a layer that was never fetched fetches it first. |
| `supersplat:list-layers` | none | `{ ok, upAxis, layers: Layer[], clipVolumes: string[], background }` |
| `supersplat:frame-layer` | `layerId` | `{ ok, pose, layer }`. Selects the layer and frames it. |
| `supersplat:set-camera-pose` | `position: [3]`, `target: [3]`, `fov` (optional, degrees), `space` (`'frame'` by default, or `'world'`) | `{ ok, upAxis, pose }` |
| `supersplat:get-camera-pose` | none | `{ ok, upAxis, pose: { fov, world: { position, target }, frame: { position, target } } }` |
| `supersplat:set-background` | `kind` (`none`, `panorama`, `gradient`), `url` (for `panorama`) | `{ ok, background: { kind, url?, pictureSize } }` |
| `supersplat:apply-clip-volumes` | `volumes: [...]`, `ghost` (optional) | `{ ok, volumes: string[], ghost, layers: [{ id, state, numClipped, numLocked, numSplats }] }` |

**A layer row** has `id`, `url`, a file name (`filename` or `file`, ending in `.ply`, `.sog`, `.spz`, `.splat` or
`.ksplat`), a name (`name` or `label`), an optional `group`, the first visibility (`visible` or `default_visible`,
default true) and an optional `kind`. Only `kind: 'splat'` rows (or rows with no kind and a splat file name) become
scene elements; every other row is answered in `skipped` with its reason. A row that starts hidden is registered
and not fetched until it is first shown, so a manifest of many large files costs only what is on screen. Files are
read one at a time. Sending an id again does nothing to a layer already in the scene.

**`Layer`** is `{ id, name, group, filename, state, visible, error, numSplats, numSelected, numLocked, numDeleted,
numClipped, boundsWorld, boundsFrame }`. `state` is `idle` (registered, not fetched), `loading`, `loaded` or
`failed` (with `error`). The bounds are `{ min: [3], max: [3] }` or null while there is nothing to measure.

**Large files.** A layer is read by URL through the loader's own file system: when the server answers a
`Range: bytes=0-0` probe with `206` and a readable `Content-Range`, the file is read in ranges and is never held
whole in memory; otherwise it is downloaded whole, with progress. Either way the editor keeps reading from the URL
afterwards (export and the data panel read rows again), so the URL must stay valid while the layer is loaded.

**The frame.** `upAxis: 'z'` says the host's frame is x east, y north, z up (a surveyed site frame, in metres).
The editor's world is y up. The one rule, applied to every layer's element and to every position, target and clip
volume the host sends, is a quarter turn about x:

    world = (x, z, -y)        frame = (x, -z, y)

So a splat 3 m east, 4 m north and 5 m up is at world (3, 5, -4), and the Transform panel shows a host layer with
rotation -90 about x. `upAxis: 'y'` turns nothing. Positions and targets are read in the frame unless
`space: 'world'`; every answer carries both.

**Clip volumes** are oriented boxes: `{ id, centre: [3], halfSize: [3], yawDeg, appliesTo: [layer ids] }` (the
spellings `centre_m`, `half_size_m`, `yaw_deg_ccw_about_up` and `applies_to` are read too). `yawDeg` turns the box
counter-clockwise seen from above, about the frame's up axis. Every gaussian of an `appliesTo` layer whose centre is
inside a box gets the editor's own **locked** state bit, found with the editor's own box test on the GPU; nothing is
deleted and nothing enters the undo history, so the scene is not made dirty. Each request replaces the volumes in
force: the bits the last request set are cleared first, and `volumes: []` gives everything back. Bits a person set
by hand (Select > Lock Selection) are left alone both ways; note that the editor's own Unlock All also unlocks what
a volume locked, until the next request. While volumes are in force the locked colour is made fully clear, so what
a volume hides is gone from the picture; `ghost: true` keeps the editor's usual faint locked colour. A layer loaded
later is clipped as it arrives. Locked gaussians are still written by an export.

**The background** is drawn behind the viewport from the editor's own camera: `gradient` is a drawn sky, `panorama`
an equirectangular picture whose columns are longitude `atan2(z, x)` in the world (east in the middle column, north
a quarter of the width to its left) and whose top row is straight up. It is a view aid: image, video and viewer
exports still use the background colour.

### Version 2: what the editor reports

`supersplat:event` messages go to the embedding page without being asked:

| `event` | Fields | When |
| --- | --- | --- |
| `layer` | `layer: Layer` | A host layer starts loading, is loaded, fails, is shown or hidden (also from the Scene Manager), or is deleted. |
| `layer-progress` | `layerId`, `text`, `progress` (0 to 100, or null when the size is unknown) | While a layer's file is read, sorted and uploaded; at most ten a second. |
| `state` | `dirty`, `selection` (layer name), `numSelected`, `numSplats`, `numLayers` | Whenever any of them changes. |

```js
const editor = document.querySelector('iframe').contentWindow;
window.addEventListener('message', (event) => {
    if (event.source !== editor) return;
    if (event.data.type === 'supersplat:ready') {
        editor.postMessage({
            type: 'supersplat:load-layers',
            id: 1,
            upAxis: 'z',
            layers: [
                { id: 'site', label: 'Site', kind: 'splat', file: 'site.ply', url: '/scenes/site.ply' },
                { id: 'room', label: 'Room', kind: 'splat', file: 'room.ply', url: '/scenes/room.ply', default_visible: false }
            ]
        }, location.origin);
    }
});
```

## Localizing the SuperSplat Editor

The currently supported languages are available here:

https://github.com/playcanvas/supersplat/tree/main/static/locales

### Adding a New Language

1. Add a new `<locale>.json` file in the `static/locales` directory.

2. Add the locale to the list here:

   https://github.com/playcanvas/supersplat/blob/main/src/ui/localization.ts

### Testing Translations

To test your translations:

1. Run the development server:

   ```sh
   npm run develop
   ```

2. Open your browser and navigate to:

   ```
   http://localhost:3000/?lng=<locale>
   ```

   Replace `<locale>` with your language code (e.g., `fr`, `de`, `es`).

## Contributors

SuperSplat is made possible by our amazing open source community:

<a href="https://github.com/playcanvas/supersplat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=playcanvas/supersplat" />
</a>
