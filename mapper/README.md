# Three Projector Mapper — prototype

A focused Windows x64 projection mapper derived from Ghost Arcade. One local
ProPresenter NDI video feed, one continuous canvas, and three independent
1920×1080 output meshes. Controls stay on a fourth operator display.

## Bundled Windows test package

The `Mapper Windows bundle` GitHub Actions workflow compiles the receiver on
Windows, stages the official app-local NDI runtime and license notices, and
produces a portable Windows x64 ZIP. Extract the entire archive and run
`Three Projector Mapper.exe`. Do not run it from inside the ZIP or copy only
the executable. No Node.js, SDK, build tools or separate runtime installation
is required on the test PC. Review/accept the included NDI terms on first run.

The bundle is unsigned. Its automated smoke test checks Electron startup,
three preview renderers and a local NDI send/receive color test. This does not
replace testing the actual ProPresenter feed or projector hardware.

## What works in the prototype

- Animated test source, independent unprocessed input preview, and three
  full-resolution GPU output canvases. The wide canvas scales to the window.
- Preview-only output destinations with no projector/EDID dependency.
- Independent 5×5 meshes and four-point polygon masks; drag the visible handles.
- Source crop placement from overlap, fit/fill/stretch, per-output edge fades,
  display gamma, brightness and basic black-level lift.
- Resizable output preview windows and desktop fullscreen display assignment.
- Blackout, calibration lock, undo/redo, autosave, and versioned JSON rig export/import.
- Windows receiver source: local NDI discovery, native capture worker, bounded
  latest-frame buffer, RGBX/RGBA upload, padded-row handling, source FPS/frame
  count/age, and stale-signal black after two seconds.

Start with zero overlap (5760×1080). Setting overlap to 192 produces a
5376×1080 canvas. The wide input is not silently squashed into 16:9 previews.
An ordinary 1920×1080 input defaults to fit, leaving side bars on a wide canvas;
select stretch only if intended, or configure ProPresenter with the wide size.

## Run preview mode on this workspace

Node.js 22.12+ is required by the installed Electron toolchain (Node 24 LTS recommended).

```sh
cd mapper
npm ci
npm run dev
```

Open http://127.0.0.1:1430/. Browser mode supports patterns and calibration;
NDI and physical display routing require the desktop app. Allow local popups
for the separate output previews. `npm run desktop` builds and launches Electron.

The mapper folder is self-contained and can be copied to the Windows PC.
Do not copy node_modules between operating systems; run npm ci on Windows.

## Build and run with NDI on Windows x64

1. Install Node 24 x64, CMake, and Visual Studio 2022 Build Tools with Desktop
   development with C++, MSVC x64 and Windows SDK.
2. Download and install the **standard NDI SDK for Windows** from
   https://ndi.video/for-developers/ndi-sdk/download/ and review its agreement.
   Advanced SDK/trial is not required. The SDK headers are not committed here.
3. Install the official NDI x64 runtime if not already present. The runtime
   is separate from this source and is not bundled by the prototype installer.
   Do not rely on ProPresenter's private DLL directory.
4. From PowerShell in the mapper folder, run:

```powershell
npm ci
$env:NDI_SDK_DIR = 'C:\Program Files\NDI\NDI SDK'
# Optional if the runtime is not found via its standard installation:
# $env:MAPPER_NDI_RUNTIME = 'C:\path\to\Processing.NDI.Lib.x64.dll'
npm run native:build
npm run desktop
```

Alternatively run `Start-Mapper.cmd` after installing the prerequisites. It
installs locked dependencies, builds/checks the receiver, and launches the app.
`Start-Mapper.cmd -PreviewOnly` skips the receiver for calibration testing.
If PowerShell policy blocks local scripts, use the individual commands above;
the launcher does not change your execution policy.

`NDI_SDK_DIR` must contain Include/Processing.NDI.Lib.h and the dynamic-load
header. Set it to your actual SDK folder. CMake builds a Node-API addon against
the host Node headers; Node-API version 9 is supported by this Electron target.
The receiver does not link an NDI import library. It dynamically loads the
official x64 DLL from an explicit path, app folder, runtime environment variable,
or known NDI runtime/SDK directory. Restart the app after installing the runtime.

```powershell
# Optional portable pixel-copy test from the VS x64 developer shell:
cl /std:c++17 /EHsc native\pixels.test.cpp /Fe:$env:TEMP\mapper-pixels-test.exe
& "$env:TEMP\mapper-pixels-test.exe"

# Build an x64 NSIS installer. Fails if receiver or runtime is unavailable:
npm run package:win
```

Output is under release/. The bundled build stages app-local runtime DLLs
under bundle/runtime and license files under bundle/licenses before packaging;
see the workflow for the complete build. The source development commands can
still use a separately installed runtime. NDI Tools are not bundled. Preserve
the separate AGPL and NDI terms when transferring the private test package.

## First Windows reception test — no projectors required

1. Run ProPresenter on the same PC and enable an NDI audience output.
2. Run the mapper. Confirm that the runtime status says the receiver is ready.
3. Select NDI from ProPresenter, refresh discovery, select its source, and Connect.
4. Keep all three destinations at Preview only. The input picture must appear,
   received count must increase, input size must match ProPresenter, and age
   should remain low. Test pure red/green/blue content and a moving frame counter.
5. Open each output preview. Each should show its own portion of the input.
6. Drag a Center mesh point: Left and Right geometry must stay unchanged.
   Switch to Screen mask and drag its four boundary points to test clipping.
7. Blackout: outputs must turn black while input remains live and count advances.
8. Stop and restart the sender. After two seconds without frames, outputs go
   black and status says stalled. Existing SDK connection can reconnect; if the
   sender changes its source name, select the new name and reconnect manually.
9. Export/reload a rig and restart the mapper to check calibration persistence.
10. Only then assign the real projector displays. The operator display is
    excluded and also rejected by the main process. Escape closes an output.

## Validation and current limits

Validated on the development Mac: TypeScript/Vite production build; four rig
tests; native portable pixel tests for padded rows, RGB channel ordering and
alpha normalization; browser wide-canvas previews. Windows native addon,
ProPresenter reception, and physical multi-display behavior still require
Windows hardware testing. This repository does not contain a verified Windows
binary. Build the receiver before calling the NDI input operational.

The prototype targets 30 preview/output frames per second. Capture runs in a
native worker independently, but UI upload/render still copies pixels. Output
windows present canvas capture streams, not a verified zero-copy/genlocked
pipeline. Full-width 60fps, long-running stability and latency need profiling
on the RTX 2060. Large textures are uploaded separately to three GPU contexts.
Blend curves use local source coordinates; real overlap alignment, gamma and
black compensation need projector validation. Black lift is basic, not a
spatially calibrated black-level solver. Masks cannot eliminate projector
black-floor light. Calibration handles can create a folded mesh; reset geometry
if needed. This first build supports four-point masks, not painted/Bezier masks.

Upstream source stays outside this folder for reference. Unneeded VJ/mobile/3D
code is excluded from this application's entry point and package rather than
being deleted before reuse is validated. No upstream update or publishing
endpoints or signing identities are used. Fork:
https://github.com/ItsJavild/ghost-arcade/tree/mapper/windows-bundle

The dependency audit found 15 moderate advisories in the packaging toolchain
after upgrading cmake-js to remove high/critical tar advisories. Do not use
`npm audit fix --force` to downgrade electron-builder to an obsolete major.

## Attribution

Derived from https://github.com/riskcapital/ghost-arcade,
commit a2c62b104fab82f93081382cd592826f0457fd01.
Original work Copyright 2024–2026 Risk Capital Media LLC. AGPL-3.0-only;
see LICENSE. The calibration patterns are copied from upstream testPatterns.ts.
The reduced output renderer and NDI receiver adapt upstream implementation
concepts. Three.js and the development dependencies retain their own licenses.

NDI® is a registered trademark of Vizrt NDI AB. https://ndi.video/
