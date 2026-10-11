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

| Message | Direction | Fields | Result |
| --- | --- | --- | --- |
| `supersplat:ready` | editor to host | none | Sent once when the editor can take requests. |
| `supersplat:is-scene-dirty` | host to editor | none | `boolean`: the scene has unsaved changes. |
| `supersplat:navigate-home` | editor to host | none | The menubar logo was clicked; the host owns navigation. |
| `supersplat:import` | host to editor | `url`, `filename` (optional when the URL ends in one) | `{ ok, filename, imported: string[], stats }`. Loads the file exactly as the `?load=` URL parameter does. |
| `supersplat:scene-stats` | host to editor | none | `{ dirty, documentName, selection, splats: [{ name, filename, visible, numSplats, numSelected, numLocked, numDeleted }] }`. |
| `supersplat:export` | host to editor | `fileType` (`ply`, `compressedPly`, `splat`, `sog`, `spz`), `filename` (optional), `maxSHBands` (optional, 0 to 3) | `{ ok, filename, fileType, byteLength, data: ArrayBuffer }`. The visible splats, written with the editor's own writers; the buffer is transferred, not copied. |

A failed request answers `{ ok: false, error }`.

```js
const editor = document.querySelector('iframe').contentWindow;
window.addEventListener('message', (event) => {
    if (event.source !== editor) return;
    if (event.data.type === 'supersplat:ready') {
        editor.postMessage({ type: 'supersplat:import', id: 1, url: '/scenes/site.ply' }, location.origin);
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
