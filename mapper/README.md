# Three Projector Mapper 0.2.0

Windows x64 projection mapper derived from Ghost Arcade. One local ProPresenter
NDI input, one continuous stage, three independently calibrated 1920×1080
projectors, and a separate operator display.

## Portable Windows package

Extract the entire Windows x64 ZIP and run **Three Projector Mapper.exe**.
Keep the executable, resources, runtime DLLs and notices together. Review the
included NDI terms on first launch. No Node.js, SDK, build tools, NDI Tools or
separate runtime installation is needed on the test computer. Build is unsigned.

Choose the ProPresenter NDI source and Connect. Destinations can stay Preview
only without any physical projectors. The operator monitor is reserved for
controls. Escape closes an output window. Export your existing rig before
switching versions; 0.1.0 rigs import into 0.2.0 without discarding calibration.

## Layout and blending

Step 02 defines source regions on a common stage. Set overlap in pixels using
numeric fields, sliders, or draggable seam handles on the overview. Seams are
linked by default; uncheck Link both seams to adjust left/center and center/right
independently. Stage width is `5760 - left overlap - right overlap`, at 1080 high.

Auto edge blends derives each region's fade widths from its overlaps. Editing
a blend width manually turns auto off for that projector. Blend gamma adjusts
the fade separately from display gamma. The hatched overlay marks the blend
zones; it follows the warped surface and does not appear in the physical output.
Input Fit preserves aspect ratio, Fill crops, and Stretch intentionally distorts.
For a wide image, configure ProPresenter to send the matching stage aspect ratio.

## Warp adjustment

Select a projector by clicking its calibration preview. The large editor below
shows the selected output route with extra space around its raster. Geometry
can extend beyond the raster; final output always clips to the physical projector.
Blend zones belong to the full region, including its edges, and warp with it.

The workflow takes inspiration from QLab's documented video stage editor:
https://qlab.app/docs/v5/video/video-output/

- **Perspective:** four corner pins with projective texture interpolation.
- **Linear:** editable mesh, with independent horizontal/vertical split counts
  of 1, 2, 4, 8, 16 or 32. Existing 5×5 meshes retain their original points.
- **Bézier:** one bicubic patch with sixteen independently editable controls.
  This first implementation does not implement QLab's multi-patch Bézier system.
- Drag a circle to move a control; drag a square edge handle to move its edge.
- Alt-drag moves the whole region. Shift-drag fine-tunes. Ctrl disables guide snapping.
- Arrow keys nudge the selected point 1 output pixel; Shift+arrows nudge 10.
  W/A/S/D navigate controls. Numeric X/Y use the route center as origin, Y up.
- Zoom controls only the editor. Fit route + margin shows space beyond its boundary.
- Screen mask edits a separate four-point clipping polygon in projector coordinates.

Each projector has Reset mesh, Reset mask, Reset blend/color, and Reset all.
Individual resets preserve unrelated calibration. Reset all restores a 5×5
linear identity mesh, full mask, automatic blends and neutral colors while
preserving the projector's display assignment. Reset operations are undoable.
Calibration lock prevents editing and resets. Meshes can be folded by extreme
edits; reset geometry if that happens. Masks cannot eliminate projector black-floor light.

## Frame rate and latency

The 0.1.0 presentation timer was capped at 30fps. Version 0.2.0 instead:

- Receives on an independent native worker, with a latest-frame buffer.
- Copies decoded pixels outside the shared-buffer lock, then swaps buffers.
- Uploads NDI RGBA data directly to one GPU texture shared by all three outputs.
- Uses one GPU context and caches mesh geometry; unchanged images are not re-uploaded.
- Presents on display refresh, with output capture streams allowing up to 60fps.
- Updates the small input monitor at 30fps and reduced resolution, independently.

**Received / presented / source FPS** separates decoded input rate, distinct
frames submitted to the three output canvases, and the source's declared rate.
Presented FPS is not a measurement of the physical projectors' scanout. App
frame age includes a conservative estimate of request/transfer time; it is not
ProPresenter-to-projector end-to-end latency. Render time helps locate a GPU or
presentation bottleneck. On signal loss, outputs go black after two seconds.
Blackout stops output imagery while the input keeps receiving.

The optimized path still copies pixel buffers through Electron IPC and uses
canvas streams for separate windows. It is not a verified zero-copy/genlocked
pipeline. Actual sustained 60fps and end-to-end latency must be measured on the
RTX 2060 with ProPresenter active. QLab behavioral parity is not claimed.

## Development and Windows build

Node 24 x64, CMake and Visual Studio 2022 C++ Build Tools are needed only on the
build machine. Install the standard Windows NDI SDK and set NDI_SDK_DIR to its
root. SDK/runtime binaries are ignored by Git and use NDI's separate license.

```powershell
npm ci
$env:NDI_SDK_DIR = 'C:\Program Files\NDI\NDI SDK'
$env:MAPPER_NDI_RUNTIME = "$env:NDI_SDK_DIR\Bin\x64\Processing.NDI.Lib.x64.dll"
npm run native:build
npm run desktop
```

`npm run dev` starts browser calibration preview at http://127.0.0.1:1430/.
Browser mode has no NDI input or physical display routing. `npm test` runs the
rig/warp tests. The portable C++ pixel-copy test is native/pixels.test.cpp.

The Mapper Windows bundle GitHub Actions workflow builds the native bridge,
stages the main NDI x64 runtime DLL and app-local MSVC runtime, includes license
notices, packages Electron and smoke-tests the packaged executable. Tests cover
all three warp modes with RGBA GPU uploads plus SDK loopback reception. No
unused DirectShow/UWP NDI variants, VJ decks, media catalogs, 3D simulator,
mobile code, upstream update endpoints or release identities are packaged.
Three.js is bundled by Vite and its unbundled npm source is excluded from the app.

## Attribution

Source: https://github.com/ItsJavild/ghost-arcade/tree/mapper/windows-bundle/mapper
Derived from Ghost Arcade a2c62b104fab82f93081382cd592826f0457fd01.
Original work Copyright 2024–2026 Risk Capital Media LLC. AGPL-3.0-only;
see LICENSE. Calibration patterns are copied from upstream testPatterns.ts.
Other dependencies retain their own licenses. NDI® is a registered trademark
of Vizrt NDI AB. https://ndi.video/
