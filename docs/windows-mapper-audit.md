# Windows three-projector mapper: source audit and proposed scope

Date: 2026-11-03. Source inspected: riskcapital/ghost-arcade `main`, commit
`a2c62b104fab82f93081382cd592826f0457fd01` (package version 1.9.993).

## Target

One Windows x64 Intel/AMD PC runs ProPresenter and the mapper. RTX 2060 12 GB;
three overlapping 1920×1080 projectors and a separate operator monitor.
One incoming picture spans one continuous screen. Receive once and share the
same source frame across all three projector pipelines.

This is a static source audit and architecture recommendation. No Windows
build, NDI runtime, ProPresenter integration, or projector hardware has been
tested. The upstream repository has been cloned locally; no GitHub fork has
been created. No application behavior has been changed.

## Source selection

The upstream README advertises a 2.x Rust/wgpu branch named
`codex/windows-v2-testing`, but that ref returned 404 and was absent from the
branch listing during this audit. The inspected main branch is Svelte 5,
TypeScript, Vite, Electron 42, Three.js, WebGL and browser WebGPU, not a verified
Rust renderer. Use a pinned, available revision for the prototype. Reassess
2.x only if its actual source becomes available.

## Reuse and adaptation map

| Area | Existing source | Decision |
| --- | --- | --- |
| Desktop shell and display enumeration | `electron/main.js`, `electron/preload.cjs` | Reuse a reduced Windows-only shell and IPC bridge. Keep operator window separate from outputs. |
| Native NDI bridge | `electron/native/ndi_addon.cpp`, `electron/native/CMakeLists.txt` | Adapt existing discovery/receive code; remove sending. Make bridge build required for Windows release CI. |
| Source discovery UI | `src/lib/components/MediaTray.svelte` | Extract source picker, remove media-bin coupling. |
| Receiving and GPU texture upload | `src/lib/components/Canvas.svelte` around lines 4113–4230 | Extract into a single independent input service. Do not retain the whole Canvas component for input. |
| Output configuration | `src/lib/stores/screens.ts`, `src/lib/stores/settings.ts` | Reuse relevant types/defaults; replace broad settings with a focused rig model. |
| Mesh math and editing | `src/lib/renderer/geometry.ts`, `src/lib/components/MeshWarpHandles.svelte`, `ScreenWarpHandles.svelte` | Reuse useful math/interactions; expose independent destination warp per projector. Verify coordinate conventions. |
| GPU crop/warp/blend/color | `src/lib/output/blendRenderer.ts` | Reuse shader logic and GPU resources. Has corner/mesh sampling, blend curves, gamma and black-level lift. |
| Multiwindow presentation | `src/SliceOutputApp.svelte`, `src/lib/sync/outputSharedTexturePresenter.ts` | Reuse transport concepts after testing Windows support. Extend output shader for independent mesh and masks. |
| Layout overview | `src/lib/components/OutputCanvasPreview.svelte` | Reuse crop/overlap interactions; add actual live output previews. Existing overview draws layout rectangles, not proof of video reception. |
| Masking | `src/lib/renderer/engine.ts` mask materials/apply passes | Extract polygon/Bezier masking concepts. Existing masks belong to layers; create projector-local clipping after warp. |
| Calibration patterns | `src/lib/utils/testPatterns.ts` | Reuse useful grids and patterns; add animated counter and color/channel tests. |
| Persistence and undo | `src/lib/stores/layers.ts`, `history.ts` | Adapt patterns into a small versioned rig file. Avoid retaining media/3D project serialization. |

## Important implementation gaps

1. Independent projector warp is not exposed by current ScreenInspector:
   its comment around line 179 explicitly says geometric warp moved to a global
   master warp. SliceOutputApp's primary shader handles crop, rotation, color,
   blend and black lift, not independent mesh geometry. Existing mesh code is
   reusable material, not a complete three-projector calibration workflow.
2. Native receiver requests `BGRX_BGRA`, while Canvas uploads the result into
   `THREE.RGBAFormat` without a visible channel conversion in that path. Use
   `RGBX_RGBA` initially or explicitly swizzle; verify red/blue and alpha.
3. ReceiveFrame copies `width * height * 4` contiguous bytes and does not
   consult `line_stride_in_bytes`. Respect FourCC, dimensions and row stride;
   reject invalid frames and recreate textures safely on resolution changes.
4. Current receive path copies native pixels into a persistent vector, copies
   into a JS Buffer, sends through Electron IPC, and copies into texture data.
   At 1080p60, a single four-byte pixel stream is about 498 MB/s before extra
   copies. At 5376×1080×60 it is about 1.39 GB/s per full copy. Profile first;
   keep one receiver, bounded latest-frame storage, and avoid three decoders.
5. Receive polling currently follows UI requestAnimationFrame. Move capture to
   a native worker/service with a bounded latest-frame handoff; UI throttling
   must not govern capture. Share frame sequence identifiers across outputs.
6. Native bridge failures can look like an empty source list. Expose missing
   runtime, discovery, connecting, receiving, stalled and disconnected states.
7. Existing screen add/remove actions redistribute crops. Replace this behavior
   so changing an output assignment never silently changes saved calibration.
8. Existing fallback uses approximate gamma/Canvas2D processing. Placeholder
   and physical outputs must use the same shader and calibration parameters.
   A fallback must not silently change calibration appearance.

## Remove from the focused product

- VJ decks, clip launching, transitions, autopilot, snapshots and audio effects.
- Shader catalogs, ISF instruments, Hydra, p5, MilkDrop/Butterchurn and presets.
- Media library, video/GIF playback, transcoding, recording and offline export.
- 3D stage/projector simulators, model/point-cloud/splat loading and Threlte UI.
- MediaPipe gestures, AI integrations, mobile companion, QR pairing and LAN server.
- MIDI/OSC/Ableton Link, DMX, WLED, Art-Net and sACN integrations.
- NDI sending, Spout/Syphon product features, macOS/Linux/mobile packaging.
- Upstream update endpoints, branding, signing identity and release destinations.

Retain blackout, save/load, undo/redo, calibration locking and diagnostics.
Prune modules after extracting dependencies, not by deleting directories first.

Dependency candidates to remove after extraction: all FFmpeg packages,
`@foobar404/wave`, `@mediapipe/tasks-vision`, `@threlte/*`,
`audiomotion-analyzer`, `butterchurn*`, `extract-zip`, `gifuct-js`,
`hydra-synth`, `qrcode`, `ws`, and `p5`. Keep Svelte, TypeScript, Vite,
Electron, Three.js, electron-builder and relevant development tools. Keep
`node-addon-api` and `cmake-js` for the native bridge. Verify actual imports
before removing each dependency. No additional NDI npm wrapper is needed.

## NDI recommendation

Use the official standard NDI SDK for Windows x64, its C API, and a small
receiver-only C++ Node-API bridge based on the existing addon. Standard SDK
supports receiving SDR NDI sources, including the receive formats described
on the official download page. No Advanced-only feature is currently required.
Upstream comments calling the Advanced SDK free are not a licensing authority.

Use SDK headers at build time and the official x64 runtime DLL at runtime.
Prefer the documented dynamic-loading interface so a missing runtime becomes
an actionable input error while pattern mode and saved rig editing still work.
For development, use a separately installed official runtime. Choose an
app-local redistributable only after checking the downloaded SDK agreement.
Do not assume ProPresenter's private DLL installation is available for reuse.

Finder must include local sources (`show_local_sources = true`, already
present). Start with ordinary discovery; Discovery Server is optional for
troubleshooting rather than a required service for this same-PC workflow.
Use highest-bandwidth receive, progressive RGBX/RGBA initially, a native
capture worker, correct frame release and reconnect handling. Render from a
latest-frame buffer without an accumulating queue. Handle frame size/rate
changes. Leave audio with ProPresenter; the mapper should not play NDI audio.

Use NDI Studio Monitor as an independent troubleshooting receiver and Test
Patterns as an optional sender. These are development aids installed from
NDI Tools, not dependencies or tools bundled inside our installer.

NDI standard SDK is proprietary and subject to its agreement; upstream is
AGPL-3.0-only. Preserve upstream notices. Review the exact SDK agreement and
the combined distribution model before sharing an installer; dynamic loading
alone does not establish license compatibility. Keep SDK/runtime binaries out
of Git. Include required NDI link and attribution in the input panel/About.

Official references consulted:
- https://ndi.video/for-developers/ndi-sdk/download/
- https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-find
- https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-recv
- https://docs.ndi.video/all/developing-with-ndi/sdk/dynamic-loading-of-ndi-libraries
- https://docs.ndi.video/all/developing-with-ndi/sdk/software-distribution
- https://docs.ndi.video/all/developing-with-ndi/sdk/licensing

## Placeholder outputs: required first-class behavior

Create Left, Center and Right as logical 1920×1080 outputs at first launch.
Each target is either Preview only (no physical display) or an assigned
Windows display. Logical output existence and calibration never depend on
connected monitors. Disconnected projectors retain settings and revert to
preview-only; do not automatically cover the operator screen.

Show an unprocessed live input preview independently of output assignments,
plus three live processed output previews using the production output shader.
Allow optional resizable preview windows on the operator monitor. Label
preview-only outputs clearly. Do not require dummy HDMI plugs or virtual
display drivers. GPU render targets retain 1080p dimensions even when their
UI thumbnails are small. Preview refresh can be throttled independently.

Input diagnostics: selected source, detected resolution, nominal and measured
received FPS, monotonically increasing frame count, last-frame age, runtime
status and connection state. Display counts advance when real frames arrive,
even if their content stays black or static. Stalled frames must show a visible
warning; define a configurable freeze/black failure policy (default black).
Output blackout must not stop receiving or hide input diagnostics.

Provide an internal animated test pattern with obvious TEST SOURCE labeling.
This validates mapping with no SDK installed, but never counts as an NDI test.

## Canvas and calibration

Horizontal setup initially. If each adjacent seam uses overlap O pixels in
projector-equivalent coordinates, canvas width is `5760 - 2*O` at height 1080.
For example, O=192 gives 5376×1080, with crop starts 0, 1728 and 3456.
This is an example, not a measured calibration. ProPresenter should supply the
matching wide aspect ratio for full-width content; ordinary 1920×1080 input
needs an explicit fit/fill/stretch policy and cannot gain missing detail.

Keep source selection/cropping separate from projector-space destination
geometry. Per output: source crop → destination warp → projector mask →
color/blend/black compensation → preview or display. Tune blend coordinates
for the warped overlap and validate with real grids. A single master warp is
insufficient for three differently positioned projectors.

## Build order and acceptance

1. Extract a small Windows app with three preview-only outputs and animated
   pattern input. Verify crop, independent warp/mask/blend and rig save/load.
2. Build the receiver bridge against the official Windows x64 SDK. Verify
   source discovery and actual ProPresenter frames in the input preview with
   no projector attached. Test RGB, alpha, strides and source size changes.
3. Test the same pipeline across all placeholder outputs; input frame counts
   continue with physical outputs off, previews hidden, UI minimized and blackout.
4. Connect real displays; verify assignment, unplug/replug, operator protection,
   overlap alignment, independent warp and final masks. Restore the saved rig.
5. Measure sustained frame pacing, capture age, CPU/GPU/memory and a long run
   with ProPresenter active. Ordinary HDMI displays are not hardware frame-locked;
   do not promise genlock or perfectly synchronous scanout across projectors.
6. Remove unneeded modules/dependencies and create a Windows x64 installer
   with our identity and explicit runtime handling. Validate on clean Windows.

Placeholder tests prove reception and render behavior. Physical blend quality,
projector black floor, focus and geometry still require the actual projectors.
