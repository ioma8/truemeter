# TrueMeter

TrueMeter makes a best-effort browser estimate of a display's physical scale. It combines current screen dimensions with known panel profiles, high-entropy Client Hints, optional Window Management display labels, EDID-derived physical dimensions, and persisted local calibration.

It is designed for rendering real-world dimensions: a 85.60 mm card, product at actual scale, a millimetre ruler, or any other physical reference.

## Install

```bash
npm install github:ioma8/truemeter
```

The package is npm-ready; publish a release to the npm registry when a registry distribution is wanted.

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

For applications migrating from an existing local-storage key:

```ts
import { configureDisplayCalibrationStorage } from 'truemeter'

configureDisplayCalibrationStorage({
  storageKey: 'my-app:display-calibrations',
  legacyStorageKey: 'my-app:screen-scale',
})
```

Use `saveDisplayCalibration()` after a user adjusts the scale and `clearDisplayCalibration()` to reset only the active display.

## Accuracy and privacy

The resolver makes no network request at runtime. It only treats an estimate as high confidence when a panel identity is available. A browser cannot obtain the physical dimensions of an anonymous desktop monitor from resolution alone, so those displays deliberately remain a low-confidence 96 CSS-dpi fallback until a display label or local calibration is available.

The optional `getScreenDetails()` flow is permission-gated and must be called from a user gesture.

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

## Development

```bash
npm install
npm test
npm run type-check
npm run build
```
