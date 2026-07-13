import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    CSS_REFERENCE_PPI,
    DISPLAY_CALIBRATIONS_STORAGE_KEY,
    clearDisplayCalibration,
    cssPixelsForInches,
    cssPixelsForMillimetres,
    configureDisplayCalibrationStorage,
    estimateFromDeviceProfiles,
    estimateFromEdidProfiles,
    estimateFromMobileViewportProfiles,
    estimateFromUserAgentDisplayRules,
    estimateKnownDisplay,
    ppiFromResolutionAndDiagonal,
    resolveDisplayEstimateForContext,
    saveDisplayCalibration,
} from './index'
import type { DisplayContext } from './index'
import { SCREENRES_DISPLAY_PROFILES } from './data/screenResProfiles.generated'
import { DEVICE_DISPLAY_MODEL_ALIASES, DEVICE_DISPLAY_PROFILES, USER_AGENT_DISPLAY_BRAND_PATTERNS, USER_AGENT_DISPLAY_PROFILE_RULES } from './data/displayProfiles.generated'

const iPhone16: DisplayContext = {
    width: 393,
    height: 852,
    dpr: 3,
    platform: 'iPhone',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
}

const originalUserAgentDataDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgentData')

afterEach(() => {
    window.localStorage.clear()
    if (originalUserAgentDataDescriptor) {
        Object.defineProperty(navigator, 'userAgentData', originalUserAgentDataDescriptor)
    } else {
        Reflect.deleteProperty(navigator, 'userAgentData')
    }
})

describe('display calibration', () => {
    it('derives PPI from a panel resolution and physical diagonal', () => {
        expect(ppiFromResolutionAndDiagonal([3840, 2160], 27)).toBeCloseTo(163.18, 2)
    })

    it('converts physical millimetres to CSS pixels using the estimate scale', () => {
        expect(cssPixelsForMillimetres(25.4, { screenScale: 1 })).toBe(CSS_REFERENCE_PPI)
        expect(cssPixelsForMillimetres(300, { screenScale: 1.25 })).toBeCloseTo(1417.32, 2)
        expect(cssPixelsForInches(1, { screenScale: 1 })).toBe(CSS_REFERENCE_PPI)
        expect(cssPixelsForInches(12, { screenScale: 1.25 })).toBe(1440)
    })

    it('uses a matching ScreenRes panel profile for a current iPhone viewport', () => {
        const estimate = estimateKnownDisplay(iPhone16)

        expect(estimate.source).toBe('screenres-profile')
        expect(estimate.confidence).toBe('medium')
        expect(estimate.ppi).toBeCloseTo(460, 0)
        expect(estimate.screenScale).toBeCloseTo(460 / (CSS_REFERENCE_PPI * 3), 2)
    })

    it('refuses a coincidental ScreenRes viewport when pixel scale disagrees', () => {
        const estimate = estimateKnownDisplay({
            width: 360,
            height: 800,
            dpr: 1,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 13; Unknown Build/UP1A) AppleWebKit/537.36 Mobile Safari/537.36',
        })

        expect(estimate).toMatchObject({
            source: 'css-baseline',
            confidence: 'low',
        })
    })

    it('keeps an exact ScreenRes browser-model match ahead of broader databases', () => {
        const estimate = estimateKnownDisplay({
            width: 412,
            height: 915,
            dpr: 2.625,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7 Build/AP3A.240905.015)',
            model: 'Pixel 7',
        })

        expect(estimate).toMatchObject({
            source: 'screenres-model-profile',
            confidence: 'high',
            label: 'Google Pixel 7',
        })
    })

    it('uses a high-entropy Client Hints model when the reduced user agent omits it', async () => {
        const getHighEntropyValues = vi.fn().mockResolvedValue({ platform: 'Android', model: 'Pixel 7' })
        Object.defineProperty(navigator, 'userAgentData', {
            configurable: true,
            value: { platform: 'Android', model: '', getHighEntropyValues },
        })

        const estimate = await resolveDisplayEstimateForContext({
            width: 412,
            height: 915,
            dpr: 2.625,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        })

        expect(getHighEntropyValues).toHaveBeenCalledWith(['model', 'platform'])
        expect(estimate).toMatchObject({
            source: 'screenres-model-profile',
            confidence: 'high',
            label: 'Google Pixel 7',
        })
    })

    it('uses an OS-provided monitor label to select a precise external-display profile', () => {
        const estimate = estimateKnownDisplay({
            width: 3840,
            height: 2160,
            dpr: 1,
            platform: 'Windows',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            screenLabel: 'DELL U2723QE',
            isInternal: false,
        })

        expect(estimate).toMatchObject({
            source: 'screen-label-profile',
            confidence: 'high',
            label: 'Dell UltraSharp U2723QE (27" 4K)',
        })
        expect(estimate.ppi).toBe(163)
        expect(estimate.screenScale).toBeCloseTo(163 / CSS_REFERENCE_PPI, 3)
    })

    it('prefers EDID-derived dimensions over a matching catalog label in the full resolver', async () => {
        const estimate = await resolveDisplayEstimateForContext({
            width: 3840,
            height: 2160,
            dpr: 1,
            platform: 'Windows',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            screenLabel: 'DELL U2723QE',
            isInternal: false,
        })

        expect(estimate).toMatchObject({
            source: 'edid-profile',
            confidence: 'high',
            label: 'DELL U2723QE',
        })
        expect(estimate.ppi).toBeCloseTo(163, 0)
    })

    it('uses the labelled current external display instead of a handset model profile', async () => {
        const estimate = await resolveDisplayEstimateForContext({
            width: 3840,
            height: 2160,
            dpr: 1,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7 Build/AP3A.240905.015) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
            model: 'Pixel 7',
            screenLabel: 'DELL U2723QE',
            isInternal: false,
        })

        expect(estimate).toMatchObject({
            source: 'edid-profile',
            confidence: 'high',
            label: 'DELL U2723QE',
        })
        expect(estimate.ppi).toBeCloseTo(163, 0)
    })

    it('does not use a handset panel profile for an unidentified external display', async () => {
        const estimate = await resolveDisplayEstimateForContext({
            width: 1920,
            height: 1080,
            dpr: 1,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7 Build/AP3A.240905.015) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
            model: 'Pixel 7',
            screenLabel: 'Screen 1',
            isInternal: false,
        })

        expect(estimate).toMatchObject({
            source: 'css-baseline',
            confidence: 'low',
        })
    })

    it('uses a confirmed internal Mac display and its native resolution', () => {
        const estimate = estimateKnownDisplay({
            width: 1536,
            height: 960,
            dpr: 2,
            platform: 'macOS',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            screenLabel: 'Built-in Retina Display',
            isInternal: true,
        })

        expect(estimate).toMatchObject({
            source: 'internal-display-profile',
            confidence: 'high',
            label: 'MacBook Pro Retina 16-inch (2019)',
            ppi: 226,
        })
    })

    it('uses a medium-confidence Retina fallback when the browser cannot expose display type', () => {
        const estimate = estimateKnownDisplay({
            width: 1280,
            height: 800,
            dpr: 2,
            platform: 'macOS',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        })

        expect(estimate).toMatchObject({
            source: 'internal-display-profile',
            confidence: 'medium',
            label: 'MacBook Retina 13-inch',
            ppi: 227,
        })
    })

    it('resolves every bundled ScreenRes profile exactly when its display label is available', () => {
        for (const profile of SCREENRES_DISPLAY_PROFILES) {
            const isApple = /iphone|ipad|macbook/i.test(profile.name)
            const isMobile = profile.category === 'phone' || profile.category === 'tablet'
            const estimate = estimateKnownDisplay({
                width: profile.viewport[0],
                height: profile.viewport[1],
                dpr: (profile.resolution[0] / profile.viewport[0] + profile.resolution[1] / profile.viewport[1]) / 2,
                platform: isApple ? 'macOS' : isMobile ? 'Android' : 'Windows',
                userAgent: isMobile ? 'Mozilla/5.0 Mobile' : 'Mozilla/5.0',
                screenLabel: profile.name,
            })

            expect(estimate.source).toBe('screen-label-profile')
            expect(estimate.confidence).toBe('high')
            expect(estimate.label).toBe(profile.name)
            expect(estimate.ppi).toBe(profile.ppi)
        }
    })

    it('matches browser model IDs against the larger device profile database', () => {
        const estimate = estimateFromDeviceProfiles({
            width: 360,
            height: 780,
            dpr: 3,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-TEST Build/UP1A)',
            model: 'SM-TEST',
        }, {
            'sm-test': [6.2, 1080, 2340],
        })

        expect(estimate).toMatchObject({
            source: 'device-profile',
            confidence: 'high',
            signature: 'v2:profile:sm-test',
        })
        expect(estimate?.ppi).toBeCloseTo(416, 0)
        expect(estimate?.screenScale).toBeCloseTo(416 / (CSS_REFERENCE_PPI * 3), 2)
    })

    it('uses the additional carrier-device profile for a Client Hints model identifier', () => {
        const estimate = estimateFromDeviceProfiles({
            width: 480,
            height: 800,
            dpr: 1,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 2.2; 001DL Build/FRG83) AppleWebKit/533.1 Mobile Safari/533.1',
            model: '001DL',
        }, DEVICE_DISPLAY_PROFILES, DEVICE_DISPLAY_MODEL_ALIASES)

        expect(estimate).toMatchObject({
            source: 'device-profile',
            confidence: 'high',
            label: 'DELL Streak',
        })
        expect(estimate?.ppi).toBeCloseTo(186.6, 1)
    })

    it('uses the final Android Build segment with a manufacturer-qualified profile alias', () => {
        const estimate = estimateFromDeviceProfiles({
            width: 360,
            height: 640,
            dpr: 3,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 5.1; Archos Diamond Plus Build/LMY47D) AppleWebKit/537.36 Mobile Safari/537.36',
        }, {
            'archos:diamond plus': [5.5, 1080, 1920],
        }, {}, {
            'archos diamond plus': 'archos:diamond plus',
        })

        expect(estimate).toMatchObject({
            source: 'device-profile',
            confidence: 'high',
            label: 'diamond plus',
        })
        expect(estimate?.ppi).toBeCloseTo(401, 0)
    })

    it('matches precise mobile user-agent rules before falling back to viewport consensus', () => {
        const estimate = estimateFromUserAgentDisplayRules({
            width: 360,
            height: 800,
            dpr: 3,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-G991B) AppleWebKit/537.36',
        }, {
            'sm-g991b': [6.2, 1080, 2400],
        }, ['SAMSUNG'], [[0, 'SM-G991B', 'sm-g991b']])

        expect(estimate).toMatchObject({
            source: 'device-profile',
            confidence: 'high',
            signature: 'v2:profile:sm-g991b',
        })
    })

    it('uses a generated UA rule when a mobile browser does not expose a Build model token', () => {
        const estimate = estimateFromUserAgentDisplayRules({
            width: 360,
            height: 800,
            dpr: 3,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 12; CPH2207) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        }, DEVICE_DISPLAY_PROFILES, USER_AGENT_DISPLAY_BRAND_PATTERNS, USER_AGENT_DISPLAY_PROFILE_RULES)

        expect(estimate).toMatchObject({
            source: 'device-profile',
            confidence: 'high',
            label: 'reno 5 pro 5g',
        })
        expect(estimate?.ppi).toBeCloseTo(402, 0)
    })

    it('uses the generated UA rule in the full automatic-resolution chain', async () => {
        const estimate = await resolveDisplayEstimateForContext({
            width: 360,
            height: 800,
            dpr: 3,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 12; CPH2207) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        })

        expect(estimate).toMatchObject({
            source: 'device-profile',
            confidence: 'high',
            label: 'reno 5 pro 5g',
        })
    })

    it('uses a safely expanded capture-group UA model rule', async () => {
        const estimate = await resolveDisplayEstimateForContext({
            width: 240,
            height: 480,
            dpr: 2,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 10; BUZZ 1 Lite) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        })

        expect(estimate).toMatchObject({
            source: 'device-profile',
            confidence: 'high',
            label: 'buzz 1 lite',
        })
        expect(estimate.ppi).toBeCloseTo(216, 0)
    })

    it('does not let an expanded literal model match an identifier prefix', () => {
        const estimate = estimateFromUserAgentDisplayRules({
            width: 240,
            height: 480,
            dpr: 2,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 10; BUZZ 1 LiteExtra) AppleWebKit/537.36 Mobile Safari/537.36',
        }, DEVICE_DISPLAY_PROFILES, USER_AGENT_DISPLAY_BRAND_PATTERNS, USER_AGENT_DISPLAY_PROFILE_RULES)

        expect(estimate).toBeNull()
    })

    it('derives an Apple display estimate from an unambiguous anonymous viewport', () => {
        const estimate = estimateFromMobileViewportProfiles({
            width: 375,
            height: 812,
            dpr: 3,
            platform: 'iPhone',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        }, {
            'iphone x': [5.8, 1125, 2436],
            'iphone xs': [5.8, 1125, 2436],
        })

        expect(estimate).toMatchObject({
            source: 'mobile-viewport-profile',
            confidence: 'high',
            label: 'matching Apple viewport profile',
        })
        expect(estimate?.ppi).toBeCloseTo(463, 0)
    })

    it('does not guess from an ambiguous anonymous mobile viewport', () => {
        const estimate = estimateFromMobileViewportProfiles({
            width: 375,
            height: 812,
            dpr: 3,
            platform: 'iPhone',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        }, {
            'iphone x': [5.8, 1125, 2436],
            'imaginary large phone': [6.7, 1125, 2436],
        })

        expect(estimate).toBeNull()
    })

    it('derives an effective scale from EDID physical dimensions and an identified monitor label', () => {
        const estimate = estimateFromEdidProfiles({
            width: 1920,
            height: 1080,
            dpr: 1,
            platform: 'Windows',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            screenLabel: 'DELL U2723QE',
            isInternal: false,
        }, {
            u2723qe: ['U2723QE', 597, 336, 3840, 2160, 5],
        })

        expect(estimate).toMatchObject({
            source: 'edid-profile',
            confidence: 'high',
            label: 'U2723QE',
        })
        expect(estimate?.ppi).toBeCloseTo(163, 0)
        // The monitor is using a 1920px desktop mode, so each CSS pixel maps to two panel pixels.
        expect(estimate?.screenScale).toBeCloseTo((estimate?.ppi ?? 0) / (CSS_REFERENCE_PPI * 2), 5)
    })

    it('uses an unambiguous EDID model alias when the OS omits the manufacturer name', () => {
        const estimate = estimateFromEdidProfiles({
            width: 3840,
            height: 2160,
            dpr: 1,
            platform: 'Windows',
            userAgent: 'Mozilla/5.0',
            screenLabel: 'U2723QE',
        }, {
            delu2723qe: ['DELL U2723QE', 597, 336, 3840, 2160, 5],
        }, {
            u2723qe: 'delu2723qe',
        })

        expect(estimate).toMatchObject({
            source: 'edid-profile',
            label: 'DELL U2723QE',
        })
    })

    it('does not accept a generic numeric EDID monitor name as an identity', () => {
        const estimate = estimateFromEdidProfiles({
            width: 1366,
            height: 768,
            dpr: 1,
            platform: 'Windows',
            userAgent: 'Mozilla/5.0',
            screenLabel: '1620',
        }, {
            1620: ['1620', 340, 190, 1366, 768, 1],
        })

        expect(estimate).toBeNull()
    })

    it('persists the physical PPI and re-derives the scale after browser zoom changes', () => {
        const original: DisplayContext = {
            width: 1920,
            height: 1080,
            dpr: 1,
            platform: 'Windows',
            userAgent: 'Mozilla/5.0',
        }
        const originalEstimate = estimateKnownDisplay(original)
        saveDisplayCalibration(original, originalEstimate, 1.3)

        const zoomed: DisplayContext = { ...original, width: 1536, height: 864, dpr: 1.25 }
        const restored = estimateKnownDisplay(zoomed)

        expect(restored.source).toBe('saved-calibration')
        expect(restored.ppi).toBeCloseTo(CSS_REFERENCE_PPI * 1.3, 3)
        expect(restored.screenScale).toBeCloseTo(1.04, 3)
        expect(window.localStorage.getItem(DISPLAY_CALIBRATIONS_STORAGE_KEY)).toContain('"entries"')
    })

    it('keeps an unrecognised external display calibration separate from a phone profile', () => {
        const external: DisplayContext = {
            width: 1920,
            height: 1080,
            dpr: 1,
            platform: 'Android',
            userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7 Build/AP3A.240905.015) AppleWebKit/537.36 Mobile Safari/537.36',
            model: 'Pixel 7',
            screenLabel: 'Screen 1',
            isInternal: false,
        }
        const externalEstimate = estimateKnownDisplay(external)
        saveDisplayCalibration(external, externalEstimate, 1.3)

        expect(estimateKnownDisplay({ ...external, screenLabel: 'Screen 2' }).source).toBe('css-baseline')
        expect(estimateKnownDisplay({ ...external, isInternal: true, screenLabel: undefined }).source).toBe('screenres-model-profile')
    })

    it('removes only the current display calibration when reset', () => {
        const estimate = estimateKnownDisplay(iPhone16)
        saveDisplayCalibration(iPhone16, estimate, 1.25)
        clearDisplayCalibration(estimate)

        expect(estimateKnownDisplay(iPhone16).source).toBe('screenres-profile')
    })

    it('does not corrupt calibration storage when both configured keys are identical', () => {
        configureDisplayCalibrationStorage({
            storageKey: 'truemeter:test-shared-key',
            legacyStorageKey: 'truemeter:test-shared-key',
        })

        const estimate = estimateKnownDisplay(iPhone16)
        saveDisplayCalibration(iPhone16, estimate, 1.25)

        expect(estimateKnownDisplay(iPhone16).source).toBe('saved-calibration')

        configureDisplayCalibrationStorage({
            storageKey: DISPLAY_CALIBRATIONS_STORAGE_KEY,
            legacyStorageKey: 'truemeter:screen-scale',
        })
    })
})
