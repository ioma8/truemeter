import {
  getDisplayContext,
  requestDetailedDisplayContext,
  resolveDisplayEstimateForContext,
  saveDisplayCalibration,
} from 'https://cdn.jsdelivr.net/npm/truemeter@0.2.0/dist/index.js'

const card = document.querySelector('#payment-card')
const estimateOutput = document.querySelector('#estimate')
const calibration = document.querySelector('#calibration')
const calibrationValue = document.querySelector('#calibration-value')
const identify = document.querySelector('#identify')
const identifyStatus = document.querySelector('#identify-status')
let context = getDisplayContext()
let estimate

function render() {
  const scale = Number(calibration.value)
  const width = (85.6 / 25.4) * 96 * scale
  card.style.width = `${width}px`
  calibrationValue.value = `${scale.toFixed(3)}×`
  estimateOutput.value = `${estimate.ppi.toFixed(1)} PPI · ${estimate.confidence} · ${estimate.source}`
}

async function resolve(contextToResolve) {
  context = contextToResolve
  estimate = await resolveDisplayEstimateForContext(context)
  calibration.value = String(Math.min(2, Math.max(0.5, estimate.screenScale)))
  render()
}

calibration.addEventListener('input', () => {
  render()
  saveDisplayCalibration(context, estimate, Number(calibration.value))
})

identify.addEventListener('click', async () => {
  identifyStatus.textContent = 'Requesting permission…'
  try {
    const detailed = await requestDetailedDisplayContext()
    if (!detailed) {
      identifyStatus.textContent = 'Display identification is unavailable.'
      return
    }
    await resolve(detailed)
    identifyStatus.textContent = detailed.screenLabel ? `Identified: ${detailed.screenLabel}` : 'Display identified.'
  } catch {
    identifyStatus.textContent = 'Permission was not granted.'
  }
})

resolve(context)
