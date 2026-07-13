import {
  clearDisplayCalibration,
  cssPixelsForMillimetres,
  estimateKnownDisplay,
  getDisplayContext,
  requestDetailedDisplayContext,
  resolveDisplayEstimateForContext,
  saveDisplayCalibration,
} from 'https://cdn.jsdelivr.net/npm/truemeter@0.2.2/dist/index.js'

const card = document.querySelector('#payment-card')
const estimateOutput = document.querySelector('#estimate')
const calibration = document.querySelector('#calibration')
const calibrationValue = document.querySelector('#calibration-value')
const estimateBadge = document.querySelector('#estimate-badge')
const identify = document.querySelector('#identify')
const restore = document.querySelector('#restore')
const status = document.querySelector('#status')
let context = getDisplayContext()
let estimate
let manuallyCalibrated = false
let resolving = false

function render() {
  if (!estimate) return
  const scale = Number(calibration.value)
  const width = cssPixelsForMillimetres(85.6, { screenScale: scale })
  card.style.width = `${width}px`
  calibrationValue.value = `${scale.toFixed(3)}×`
  estimateBadge.textContent = manuallyCalibrated ? 'manual calibration' : estimate.confidence
  estimateOutput.value = `${estimate.ppi.toFixed(1)} PPI · ${estimate.source}`
  restore.disabled = resolving || !manuallyCalibrated
}

function setBusy(isBusy) {
  resolving = isBusy
  calibration.disabled = isBusy
  identify.disabled = isBusy
  restore.disabled = isBusy || !manuallyCalibrated
}

async function resolve(contextToResolve) {
  setBusy(true)
  context = contextToResolve
  try {
    estimate = await Promise.race([
      resolveDisplayEstimateForContext(context),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Display estimate timed out')), 10000)),
    ])
    manuallyCalibrated = estimate.source === 'saved-calibration'
    if (!manuallyCalibrated) status.textContent = 'Using the automatic display estimate.'
    calibration.value = String(Math.min(2, Math.max(0.5, estimate.screenScale)))
    render()
  } catch {
    // Keep the demo usable if a browser blocks an optional capability or a CDN chunk
    // cannot be loaded. The synchronous resolver still provides the CSS baseline.
    estimate = estimateKnownDisplay(context)
    manuallyCalibrated = false
    calibration.value = String(Math.min(2, Math.max(0.5, estimate.screenScale)))
    status.textContent = 'Automatic enhancements are unavailable; showing the CSS baseline.'
    render()
  } finally {
    setBusy(false)
    render()
  }
}

calibration.addEventListener('input', render)
calibration.addEventListener('change', () => {
  if (!estimate) return
  manuallyCalibrated = true
  render()
  saveDisplayCalibration(context, estimate, Number(calibration.value))
  status.textContent = 'Calibration saved for this display.'
})

identify.addEventListener('click', async () => {
  status.textContent = 'Requesting display permission…'
  setBusy(true)
  try {
    const detailed = await requestDetailedDisplayContext()
    if (!detailed) {
      status.textContent = 'Display identification is unavailable in this browser.'
      return
    }
    await resolve(detailed)
    status.textContent = detailed.screenLabel ? `Identified: ${detailed.screenLabel}` : 'Display identified.'
  } catch {
    status.textContent = 'Display permission was not granted.'
  } finally {
    setBusy(false)
    render()
  }
})

restore.addEventListener('click', async () => {
  if (!estimate) return
  clearDisplayCalibration(estimate)
  status.textContent = 'Re-evaluating this display automatically…'
  await resolve(context)
})

resolve(context)
