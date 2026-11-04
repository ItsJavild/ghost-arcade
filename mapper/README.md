# Three Projector Mapper 0.5.0

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

## Live performance mode (0.5.0)

Connecting NDI leaves previews available for checking and calibration. Choose
**Live mode · previews off** when ready to pause operator previews and lock
calibration. **Return to live input** also enters Live mode after clearing
diagnostic modes and Blackout. **Calibrate · previews on** resumes the input monitor and calibration
view without reconnecting NDI or reopening projector outputs; it restores the
prior monitor/lock settings. **Live mode · previews off** pauses them again.
Metrics and source-loss handling remain active. Blackout and diagnostic settings
are not changed by this performance switch, so check the output status banner.

This skips input-monitor CPU conversion/copies and warp-editor preview copies,
and hides operator canvas presentation. The three calibrated output canvases,
shared GPU input texture and their capture streams remain alive and rendering.
They are required to feed the actual projector windows. The Windows smoke test
requires changing frames in all three outputs with operator previews paused,
checks preview-copy counters stay unchanged, then verifies preview resumption.

The ZIP is an already-packaged native Electron application. An NSIS installer
would copy the same executable/runtime and add install/uninstall integration;
it would not change this application's decoding or rendering pipeline. Keep the
ZIP extracted to a local folder, with all DLLs and resources together.

## Setup safeguards (0.4.0)

Open **Setup guide** for an offline one-hour checklist. `START-HERE.txt` is also
included beside the executable. Connect all displays before launch and put the
operator window on the control monitor before routing outputs. The operator
monitor is pinned while physical outputs are active. The app prevents display
sleep, blocks accidental reload/zoom shortcuts and prompts before closing active
outputs. Windows native occlusion backgrounding is disabled so covered operator/output
windows keep rendering; the packaged test deliberately stacks the previews and
requires changing frames in all three. A second launch focuses the existing mapper instead of competing for NDI.

**Open all assigned outputs** routes assigned displays and opens placeholders for
unassigned outputs. **Identify outputs** shows raster labels (bypasses geometry)
to check cable order. Disable it before calibration. **Solo selected projector**
blacks the other two outputs. Temporary modes are visibly indicated and reset on
launch; **Return to live input** clears patterns, identification, Solo and Blackout.

Calibration patterns override input without disconnecting NDI. Continuous grid,
white, 50% gray, black and bars still use the selected warp, mask and fades. Black
omits software black lift so it reveals projector black floor. Use white/gray with
Solo OFF to check seams. Output status reports decoded video dimensions and frame
counts from each separate output window; it cannot measure HDMI scanout.

Disk autosave writes `calibration.json` in Electron's per-user application-data
folder and retains `calibration.previous.json`. Writes use same-volume rename;
invalid JSON cannot replace the last saved state. Browser storage remains a
fallback. **Restore previous autosave** is undoable. Export rig JSON at milestones;
a previous-state backup is not a long-term version history. A display disconnect
closes only its routed output. Reconnect, refresh displays and reopen it; HDMI
routing changes on the actual RTX 2060 remain a hardware test.

Disable **Input monitor** to skip its CPU image conversion/copy while outputs keep
rendering. NDI SDK connection, queue and dropped-frame counters appear below the
input metrics. **Save diagnostics** exports those counters, configuration and
display details with no captured video. A render exception clears output canvases
to black and offers **Restart preview engine**; reconnect/reopen afterward.

## Layout and blending

The Calibration workspace combines canvas layout, overlap, display routing and projector calibration. Use Selected projector to switch between the three independent outputs. It defines source regions on a common stage. Set overlap in pixels using
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

Select a projector in Calibration and choose Open warp adjustment. A separate
modal tool (Done or Escape closes it) shows the selected output route with extra space around its raster. Geometry
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

The input monitor refreshes at up to 30fps; this limit does not cap output rendering.
The warp tool only copies its preview while open. NDI reception, GPU rendering and
operator thread scheduling are shared with physical outputs. Output windows use
canvas capture streams and video presentation, which can add buffering. App frame
age is not an end-to-end measurement; compare a source clock with a physical
projector to measure actual latency. A delayed preview alone cannot prove output
latency is acceptable.


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
