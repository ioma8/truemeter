# TrueMeter

[![CI](https://github.com/ioma8/truemeter/actions/workflows/ci.yml/badge.svg)](https://github.com/ioma8/truemeter/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/truemeter)](https://www.npmjs.com/package/truemeter) [![npm downloads](https://img.shields.io/npm/dm/truemeter)](https://www.npmjs.com/package/truemeter)

**TrueMeter makes browser UI physically honest.** It estimates a display's physical scale and turns known millimetres into correctly sized CSS pixels — for products at true size, a 85.60 mm payment card, a millimetre ruler, or any physical reference.

It combines current screen dimensions with known panel profiles, high-entropy Client Hints, optional Window Management display labels, EDID-derived physical dimensions, and persisted local calibration. Resolution alone is never treated as a monitor's physical size.

## Install

```bash
npm install truemeter
```

The package has no runtime dependencies. The import name is `truemeter`.

Try the [live true-size demo](https://ioma8.github.io/truemeter/), or browse the [changelog](./CHANGELOG.md).

## Use

```ts
import {
  resolveDisplayEstimate,
  requestDetailedDisplayContext,
  resolveDisplayEstimateForContext,
} from 'truemeter'

const estimate = await resolveDisplayEstimate()
// estimate.screenScale converts CSS millimetres to this display's physical scale.

// Call this directly from a button click. Supporting browsers can ask for the
// Window Management permission and expose the current display label.
const detailed = await requestDetailedDisplayContext()
const preciseEstimate = detailed
  ? await resolveDisplayEstimateForContext(detailed)
  : estimate
```

`DisplayEstimate` includes `ppi`, `screenScale`, `pixelsPerCssPixel`, `source`, `confidence`, `label`, and a stable calibration `signature`.

## Browser support

TrueMeter works in modern evergreen browsers. It uses ordinary screen metrics everywhere and progressively enhances the estimate with Client Hints, Window Management display labels, and local storage when those capabilities are available. Unsupported or anonymous displays receive a conservative CSS baseline and can always be calibrated manually.

The library is browser-first and has no runtime network requests. The optional display-label permission must be requested from a user gesture.

## Render an image at its true physical size

To render an image at a physical width of 30 cm, convert 300 millimetres to CSS pixels using the display estimate:

```ts
import { cssPixelsForMillimetres, resolveDisplayEstimate } from 'truemeter'

const estimate = await resolveDisplayEstimate()
const widthInCssPixels = cssPixelsForMillimetres(300, estimate)

imageElement.style.width = `${widthInCssPixels}px`
imageElement.style.height = 'auto'
```

For inch-based measurements, use `cssPixelsForInches(12, estimate)` in the same way.

`screenScale` is the correction from CSS's nominal 96 dpi to the current display. A 1 mm CSS reference requires `CSS_REFERENCE_PPI / 25.4 * screenScale` CSS pixels. Show a calibration control whenever the result is not `verified`; save its value with `saveDisplayCalibration()` so future renders on that display become verified.

For applications migrating from an existing local-storage key:

```ts
import { configureDisplayCalibrationStorage } from 'truemeter'

configureDisplayCalibrationStorage({
  storageKey: 'my-app:display-calibrations',
  legacyStorageKey: 'my-app:screen-scale',
})
```

Use `saveDisplayCalibration()` after a user adjusts the scale and `clearDisplayCalibration()` to reset only the active display.

## Accuracy, confidence, and privacy

The resolver makes no network request at runtime. It only treats an estimate as high confidence when a panel identity is available. A browser cannot obtain the physical dimensions of an anonymous desktop monitor from resolution alone, so those displays deliberately remain a low-confidence 96 CSS-dpi fallback until a display label or local calibration is available.

The optional `getScreenDetails()` flow is permission-gated and must be called from a user gesture.

| Confidence | Meaning | Recommended UX |
| --- | --- | --- |
| `verified` | A local calibration was saved for this display identity. | Render at true size. |
| `high` | A specific panel or display label matched. | Render at true size; leave calibration available. |
| `medium` | A conservative, unambiguous internal/mobile match. | Render with a visible calibration affordance. |
| `low` | No physical panel identity is available; uses the CSS baseline. | Do not claim precision; ask the user to calibrate. |

## Benchmark and test coverage

TrueMeter's automated test suite has **28 resolver tests**. Its data-driven benchmark resolves **all 75 bundled ScreenRes profiles** using each profile's label, viewport, pixel ratio, and expected PPI. The suite also covers the resolver's critical safety and precedence rules:

- saved calibrations surviving browser zoom and remaining isolated by display;
- EDID dimensions beating catalog labels, plus ambiguous and generic-label rejection;
- identified external displays never inheriting a laptop or handset panel;
- Client Hints, device model aliases, Android user-agent rules, and conservative viewport fallbacks;
- internal Retina Mac displays, exact ScreenRes labels, and the anonymous-display CSS fallback.

The bundled data currently contains 6,495 device profiles, 3,386 user-agent rules, 12,093 EDID profiles, 75 ScreenRes records, and 8 Apple internal-display profiles. This is **resolver and source-data coverage**, not a hardware-lab accuracy claim: browser privacy boundaries prevent automatic verification of an anonymous monitor's physical dimensions. A user calibration is the definitive fallback and is intentionally persisted per display.

## Data and updates

The package dynamically loads the larger profile indexes only when resolving an estimate:

- `node-device-detector` and OpenSTF device panel data
- ScreenRes display profiles
- Linux Hardware EDID profiles
- Apple built-in display profiles

Run `npm run sync-display-profiles` to refresh mobile and ScreenRes profiles. To regenerate EDID data, clone [linuxhw/EDID](https://github.com/linuxhw/EDID) and run:

```bash
EDID_SOURCE_DIR=/path/to/EDID/Digital npm run sync-edid-profiles
```

See [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) for source licenses. The code is MIT; generated profile data retains its source-specific attribution and licence obligations.

## API

The recommended application API is intentionally small:

- `resolveDisplayEstimate(): Promise<DisplayEstimate>` resolves the current browser display.
- `resolveDisplayEstimateForContext(context): Promise<DisplayEstimate>` resolves a supplied context for integrations and tests.
- `cssPixelsForMillimetres(millimetres, estimate): number` converts millimetres to CSS pixels.
- `cssPixelsForInches(inches, estimate): number` converts inches to CSS pixels.
- `requestDetailedDisplayContext(): Promise<DisplayContext | null>` optionally identifies the current display after a user gesture.
- `saveDisplayCalibration(context, estimate, screenScale): void` saves a user-adjusted scale for that display.
- `clearDisplayCalibration(estimate): void` removes the active display's saved calibration.
- `configureDisplayCalibrationStorage(options): void` changes storage keys when migrating an existing application.

The main public types are `DisplayContext` and `DisplayEstimate`. `DisplayContext` contains `width`, `height`, `dpr`, `platform`, and `userAgent`, with optional `model`, `screenLabel`, and `isInternal` fields. `DisplayEstimate` contains `ppi`, `screenScale`, `pixelsPerCssPixel`, `source`, `confidence`, optional `label`, and a stable calibration `signature`.

`getDisplayContext()`, `getPermittedDetailedDisplayContext()`, and `canIdentifyDisplay()` are available for applications that need explicit permission or capability handling. The profile-matching and PPI helper exports are low-level compatibility exports; typical applications should not need them.

See the exported TypeScript declarations for the complete API contract.

## Development

```bash
npm install
npm run check
```

The repository also contains a static demo in [`docs/`](./docs/), which is deployed to GitHub Pages after changes to `main`.

`npm run check` runs strict TypeScript validation, the resolver suite, a production build, and `npm pack --dry-run`. GitHub Actions runs the same check on Node 20, 22, and 24 for pushes, tags, and pull requests.
