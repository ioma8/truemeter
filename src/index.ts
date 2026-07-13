import { SCREENRES_DISPLAY_PROFILES, type ScreenResDisplayProfile } from './data/screenResProfiles.generated'
import { APPLE_INTERNAL_DISPLAY_PROFILES } from './data/internalDisplayProfiles'

export const CSS_REFERENCE_PPI = 96
export const DISPLAY_CALIBRATIONS_STORAGE_KEY = 'truemeter:display-calibrations'
export const LEGACY_SCREEN_SCALE_STORAGE_KEY = 'truemeter:screen-scale'

let calibrationStorageKey = DISPLAY_CALIBRATIONS_STORAGE_KEY
let legacyScreenScaleStorageKey = LEGACY_SCREEN_SCALE_STORAGE_KEY

/** Configure persistent keys before resolving estimates in an application with existing calibration data. */
export function configureDisplayCalibrationStorage(options: {
    storageKey?: string
    legacyStorageKey?: string
}): void {
    if (options.storageKey) calibrationStorageKey = options.storageKey
    if (options.legacyStorageKey) legacyScreenScaleStorageKey = options.legacyStorageKey
}

export type DisplayEstimateSource = 'saved-calibration' | 'device-profile' | 'mobile-viewport-profile' | 'internal-display-profile' | 'edid-profile' | 'screen-label-profile' | 'screenres-model-profile' | 'screenres-profile' | 'css-baseline'
export type DisplayEstimateConfidence = 'verified' | 'high' | 'medium' | 'low'

export interface DisplayContext {
    width: number
    height: number
    dpr: number
    platform: string
    userAgent: string
    model?: string
    screenLabel?: string
    isInternal?: boolean
}

export interface DisplayEstimate {
    ppi: number
    screenScale: number
    pixelsPerCssPixel: number
    source: DisplayEstimateSource
    confidence: DisplayEstimateConfidence
    label?: string
    signature: string
}

interface StoredDisplayCalibration {
    ppi: number
    updatedAt: string
}

interface StoredDisplayCalibrations {
    version: 1
    entries: Record<string, StoredDisplayCalibration>
}

interface PanelProfile {
    name: string
    diagonalInches: number
    resolution: readonly [number, number]
    viewport?: readonly [number, number]
    ppi?: number
}

interface DeviceDisplayProfileModule {
    DEVICE_DISPLAY_PROFILES: Record<string, readonly [diagonalInches: number, width: number, height: number, displayName?: string]>
    DEVICE_DISPLAY_MODEL_ALIASES: Record<string, string>
    DEVICE_DISPLAY_USER_AGENT_ALIASES: Record<string, string>
    USER_AGENT_DISPLAY_BRAND_PATTERNS: readonly string[]
    USER_AGENT_DISPLAY_PROFILE_RULES: readonly (readonly [brandPatternIndex: number, modelPattern: string, model: string, requireModelTerminator?: boolean])[]
}

interface EdidDisplayProfileModule {
    EDID_DISPLAY_PROFILES: Record<string, readonly [label: string, widthMm: number, heightMm: number, width: number, height: number, samples: number]>
    EDID_MODEL_ALIASES: Record<string, string>
}

interface UserAgentDataLike {
    platform?: string
    model?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ platform?: string, model?: string }>
}

interface ScreenDetailedLike {
    width: number
    height: number
    devicePixelRatio: number
    label: string
    isInternal: boolean
}

interface WindowWithScreenDetails extends Window {
    getScreenDetails?: () => Promise<{ currentScreen: ScreenDetailedLike }>
}

const EPSILON = 0.02
const userAgentRegexCache = new Map<string, RegExp | null>()

function orderedPair(width: number, height: number): readonly [number, number] {
    return width <= height ? [width, height] : [height, width]
}

function pairsMatch(first: readonly [number, number], second: readonly [number, number], tolerance = EPSILON): boolean {
    return Math.abs(first[0] - second[0]) <= tolerance && Math.abs(first[1] - second[1]) <= tolerance
}

function normalizeModel(value: string | undefined): string | null {
    if (!value) return null
    const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ')
    return normalized.length >= 2 ? normalized : null
}

function normalizeDeviceModel(value: string): string {
    return value.toLowerCase().replace(/_/g, ' ').replace(/ td$/i, '').replace(/\s+/g, ' ').trim()
}

function compactIdentifier(value: string): string {
    return value.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '')
}

function modelTokens(value: string): string[] {
    const matcher = /[a-z]*\d[a-z0-9-]*/gi
    const tokens: string[] = []
    let match = matcher.exec(value)
    while (match) {
        if (match[0].length >= 4) tokens.push(compactIdentifier(match[0]))
        match = matcher.exec(value)
    }
    return tokens
}

function normalizedPlatform(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown'
}

function isSpecificDisplayLabel(value: string | undefined): boolean {
    const label = normalizeModel(value)
    if (!label || !/[a-z]/.test(label)) return false
    // Window Management implementations sometimes return a positional name rather than a
    // hardware identity, so it needs separate handling in the display signature below.
    return !/^(?:screen|display|monitor)\s*\d*$/i.test(label)
}

function isMobileContext(context: DisplayContext): boolean {
    return /android|iphone|ipad|ipod|mobile/i.test(`${context.platform} ${context.userAgent}`)
}

function isMacContext(context: DisplayContext): boolean {
    return /mac/i.test(`${context.platform} ${context.userAgent}`) && !isMobileContext(context)
}

function average(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function ppiFromResolutionAndDiagonal(resolution: readonly [number, number], diagonalInches: number): number {
    return Math.hypot(resolution[0], resolution[1]) / diagonalInches
}

function ppiFromResolutionAndDimensions(resolution: readonly [number, number], widthMm: number, heightMm: number): number | null {
    if (!widthMm || !heightMm) return null

    const horizontalPpi = resolution[0] / (widthMm / 25.4)
    const verticalPpi = resolution[1] / (heightMm / 25.4)
    if (!Number.isFinite(horizontalPpi) || !Number.isFinite(verticalPpi) || horizontalPpi <= 0 || verticalPpi <= 0) return null

    // EDID dimensions are stored to the nearest centimetre. Reject only clear aspect-ratio
    // mismatches, while allowing the small rounding error that the format naturally has.
    if (Math.abs(horizontalPpi - verticalPpi) / average([horizontalPpi, verticalPpi]) > 0.08) return null
    return average([horizontalPpi, verticalPpi])
}

export function screenScaleForPpi(ppi: number, pixelsPerCssPixel: number): number {
    return ppi / (CSS_REFERENCE_PPI * pixelsPerCssPixel)
}

function profilePpi(profile: PanelProfile): number {
    return profile.ppi ?? ppiFromResolutionAndDiagonal(profile.resolution, profile.diagonalInches)
}

function contextSignature(context: DisplayContext, identity?: string): string {
    if (isSpecificDisplayLabel(context.screenLabel)) return `v2:display:${normalizeModel(context.screenLabel)}`
    if (identity) return `v2:profile:${normalizeModel(identity)}`

    const model = normalizeModel(context.model)
    // An external screen is the active rendering surface, so do not allow an attached phone
    // or laptop model to identify its stored calibration.
    if (model && context.isInternal !== false) return `v2:model:${model}`

    const [width, height] = orderedPair(
        Math.round(context.width * context.dpr),
        Math.round(context.height * context.dpr),
    )
    const externalPosition = context.isInternal === false ? normalizeModel(context.screenLabel) : null
    // Generic labels are not hardware identities, but including the OS-assigned position
    // keeps “Screen 1” and “Screen 2” from sharing a calibration when their resolutions match.
    return `v2:${context.isInternal === false ? 'external' : 'screen'}:${normalizedPlatform(context.platform)}:${width}x${height}${externalPosition ? `:${externalPosition}` : ''}`
}

function estimateFromPanel(
    context: DisplayContext,
    profile: PanelProfile,
    source: DisplayEstimateSource,
    confidence: DisplayEstimateConfidence,
    identity?: string,
): DisplayEstimate | null {
    const [nativeWidth, nativeHeight] = orderedPair(profile.resolution[0], profile.resolution[1])
    const [cssWidth, cssHeight] = orderedPair(context.width, context.height)
    if (!cssWidth || !cssHeight) return null

    const pixelsPerCssPixel = average([nativeWidth / cssWidth, nativeHeight / cssHeight])
    if (!Number.isFinite(pixelsPerCssPixel) || pixelsPerCssPixel <= 0) return null

    const ppi = profilePpi(profile)
    return {
        ppi,
        screenScale: screenScaleForPpi(ppi, pixelsPerCssPixel),
        pixelsPerCssPixel,
        source,
        confidence,
        label: profile.name,
        signature: contextSignature(context, identity),
    }
}

function modelCandidates(context: DisplayContext): string[] {
    const buildModelMatches = [...context.userAgent.matchAll(/;\s*([^;()]+?)\s+(?:build|wv)\//gi)]
    const terminalModelMatches = [...context.userAgent.matchAll(/;\s*([^;()]+?)[;)]/g)]
    // Android's version is also semicolon-delimited. Prefer the segment explicitly followed by
    // Build/wv; without it, the final parenthesized segment is the closest available model hint.
    const fromUserAgent = buildModelMatches.at(-1)?.[1] ?? terminalModelMatches.at(-1)?.[1]
    const candidates = [context.model, fromUserAgent]
        .map(normalizeModel)
        .filter((candidate): candidate is string => candidate !== null)

    return [...new Set(candidates)]
}

function userAgentPatternMatches(userAgent: string, pattern: string, requireModelTerminator = false): boolean {
    const cacheKey = `${requireModelTerminator ? 'model' : 'brand'}\u0000${pattern}`
    let regex = userAgentRegexCache.get(cacheKey)
    if (regex === undefined) {
        try {
            // Match node-device-detector's boundary behaviour while avoiding its 1.7 MB parser.
            const normalized = pattern.replace(/\//g, '\\/').replace(/\+\+/g, '+')
            // A physical panel profile is only safe when the model expression ends at a real
            // UA model delimiter. In particular, do not let a rule for “Buzz 1” classify a
            // hypothetical “Buzz 1 Lite Pro”. The upstream database uses spaces before Build,
            // so retain that legitimate form without accepting arbitrary trailing words.
            // Generated literals are intentionally exact. Upstream expressions are left as-is
            // because some encode a legitimate model suffix (for example `X688B`) outside the
            // matched fragment.
            const terminator = requireModelTerminator
                ? '(?=$|[);/,]|\\s+Build(?:[\\s/]|$))'
                : ''
            regex = new RegExp(`(?:^|[^A-Z0-9_-]|[^A-Z0-9-]_|sprd-|MZ-)(?:${normalized})${terminator}`, 'i')
        } catch {
            regex = null
        }
        userAgentRegexCache.set(cacheKey, regex)
    }
    return regex?.test(userAgent) ?? false
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function profileModelMatchScore(profile: ScreenResDisplayProfile, candidates: readonly string[]): number | null {
    const profileName = normalizeModel(profile.name)
    if (profileName === null) return null

    const scores = candidates
        .filter((candidate) => candidate.length >= 4)
        .map((candidate) => {
            const match = new RegExp(`(?:^|\\s)${escapeRegExp(candidate)}(?=\\s|$)`, 'i').exec(profileName)
            return match ? profileName.length - candidate.length : null
        })
        .filter((score): score is number => score !== null)
    return scores.length ? Math.min(...scores) : null
}

function screenLabelMatchRank(profile: ScreenResDisplayProfile, screenLabel: string): number | null {
    const label = compactIdentifier(screenLabel)
    const profileName = compactIdentifier(profile.name)
    if (label === profileName) return 0
    if (label.length >= 6 && profileName.includes(label)) return 1
    if (profileName.length >= 6 && label.includes(profileName)) return 2

    return modelTokens(screenLabel).some((token) => profileName.includes(token)) ? 3 : null
}

function profileMatchesViewport(profile: ScreenResDisplayProfile, context: DisplayContext): boolean {
    const profileViewport = orderedPair(profile.viewport[0], profile.viewport[1])
    const contextViewport = orderedPair(context.width, context.height)
    return pairsMatch(profileViewport, contextViewport) && Math.abs(profile.ppi) > 0
}

function profileMatchesContextPlatform(profile: ScreenResDisplayProfile, context: DisplayContext): boolean {
    if (isMobileContext(context)) return profile.category === 'phone' || profile.category === 'tablet'
    // A generic Mac viewport can overlap common Windows laptops. Only Apple laptop records
    // may be inferred without a model; confirmed built-in panels are handled separately below.
    return isMacContext(context) && profile.category === 'laptop' && /macbook/i.test(profile.name)
}

function profileMatchScore(profile: ScreenResDisplayProfile, context: DisplayContext): number {
    const nativeRatio = average([
        profile.resolution[0] / profile.viewport[0],
        profile.resolution[1] / profile.viewport[1],
    ])
    return Math.abs(nativeRatio - context.dpr) / nativeRatio
}

function selectScreenResProfile(context: DisplayContext): { profile: ScreenResDisplayProfile, confidence: DisplayEstimateConfidence, identity?: string, source?: DisplayEstimateSource } | null {
    if (context.screenLabel) {
        const labelMatch = SCREENRES_DISPLAY_PROFILES
            .map((profile) => ({ profile, rank: screenLabelMatchRank(profile, context.screenLabel ?? '') }))
            .filter((match): match is { profile: ScreenResDisplayProfile, rank: number } => match.rank !== null)
            .sort((first, second) => first.rank - second.rank || profileMatchScore(first.profile, context) - profileMatchScore(second.profile, context))[0]?.profile
        if (labelMatch) {
            return {
                profile: labelMatch,
                confidence: 'high',
                identity: `label:${context.screenLabel}`,
                source: 'screen-label-profile',
            }
        }
    }

    if (context.isInternal !== false) {
        const candidates = modelCandidates(context)
        const modelMatch = SCREENRES_DISPLAY_PROFILES
            .map((profile) => ({ profile, score: profileModelMatchScore(profile, candidates) }))
            .filter((match): match is { profile: ScreenResDisplayProfile, score: number } => match.score !== null)
            .sort((first, second) => first.score - second.score)[0]?.profile
        if (modelMatch) return { profile: modelMatch, confidence: 'high', identity: modelMatch.name, source: 'screenres-model-profile' }
    }

    const matches = SCREENRES_DISPLAY_PROFILES
        .filter((profile) => profileMatchesViewport(profile, context))
        .filter((profile) => profileMatchesContextPlatform(profile, context))
        // `screen.width` alone is not an identity. A profile must also agree with the
        // browser's device-pixel scale; this allows the documented iPhone Plus rendering
        // variance while refusing a coincidental viewport from a different panel.
        .filter((profile) => profileMatchScore(profile, context) <= 0.1)
        .sort((first, second) => profileMatchScore(first, context) - profileMatchScore(second, context))

    if (!matches.length) return null

    const ppis = matches.map(profilePpi)
    const minPpi = Math.min(...ppis)
    const maxPpi = Math.max(...ppis)
    const medianPpi = ppis.sort((first, second) => first - second)[Math.floor(ppis.length / 2)]
    if (!medianPpi || (maxPpi - minPpi) / medianPpi > 0.06) return null

    const representative = matches.reduce((best, profile) => {
        const bestPpi = profilePpi(best)
        const candidatePpi = profilePpi(profile)
        return Math.abs(candidatePpi - medianPpi) < Math.abs(bestPpi - medianPpi) ? profile : best
    })

    return { profile: representative, confidence: 'medium' }
}

function fallbackEstimate(context: DisplayContext): DisplayEstimate {
    const pixelsPerCssPixel = context.dpr || 1
    const ppi = CSS_REFERENCE_PPI * pixelsPerCssPixel
    return {
        ppi,
        screenScale: 1,
        pixelsPerCssPixel,
        source: 'css-baseline',
        confidence: 'low',
        signature: contextSignature(context),
    }
}

function estimateFromInternalDisplayProfile(context: DisplayContext): DisplayEstimate | null {
    // Safari does not expose ScreenDetailed.isInternal. Native Retina resolutions are highly
    // distinctive, so use this as a medium-confidence Mac fallback; a confirmed external screen
    // is never allowed to take this path.
    if (!isMacContext(context) || context.isInternal === false) return null

    const [reportedWidth, reportedHeight] = orderedPair(
        Math.round(context.width * context.dpr),
        Math.round(context.height * context.dpr),
    )
    const profile = APPLE_INTERNAL_DISPLAY_PROFILES.find(({ resolution }) => pairsMatch(
        orderedPair(resolution[0], resolution[1]),
        [reportedWidth, reportedHeight],
        1,
    ))
    if (!profile) return null

    return estimateFromPanel(context, {
        name: profile.name,
        diagonalInches: Math.hypot(profile.resolution[0], profile.resolution[1]) / profile.ppi,
        resolution: profile.resolution,
        ppi: profile.ppi,
    }, 'internal-display-profile', context.isInternal ? 'high' : 'medium', `internal:${profile.name}`)
}

function readStoredCalibrations(): StoredDisplayCalibrations {
    if (typeof window === 'undefined') return { version: 1, entries: {} }

    try {
        const value: unknown = JSON.parse(window.localStorage.getItem(calibrationStorageKey) ?? '{}')
        if (!value || typeof value !== 'object') return { version: 1, entries: {} }
        const entries = (value as { entries?: unknown }).entries
        if (!entries || typeof entries !== 'object') return { version: 1, entries: {} }

        return {
            version: 1,
            entries: Object.fromEntries(
                Object.entries(entries).filter(([, entry]) => {
                    if (!entry || typeof entry !== 'object') return false
                    const ppi = (entry as { ppi?: unknown }).ppi
                    return typeof ppi === 'number' && Number.isFinite(ppi) && ppi > 0
                }),
            ) as Record<string, StoredDisplayCalibration>,
        }
    } catch {
        return { version: 1, entries: {} }
    }
}

function savedEstimate(context: DisplayContext, base: DisplayEstimate): DisplayEstimate | null {
    const stored = readStoredCalibrations()
    const calibration = stored.entries[base.signature]
    if (calibration) {
        return {
            ...base,
            ppi: calibration.ppi,
            screenScale: screenScaleForPpi(calibration.ppi, base.pixelsPerCssPixel),
            source: 'saved-calibration',
            confidence: 'verified',
        }
    }

    // Migrate the previous single scale value on the first visit to a display signature.
    if (typeof window === 'undefined' || Object.keys(stored.entries).length) return null
    try {
        const legacyScale = Number(window.localStorage.getItem(legacyScreenScaleStorageKey))
        if (!Number.isFinite(legacyScale) || legacyScale <= 0) return null
        const migrated: DisplayEstimate = {
            ...base,
            ppi: legacyScale * CSS_REFERENCE_PPI * base.pixelsPerCssPixel,
            screenScale: legacyScale,
            source: 'saved-calibration',
            confidence: 'verified',
        }
        saveDisplayCalibration(context, migrated, legacyScale)
        return migrated
    } catch {
        return null
    }
}

export function getDisplayContext(): DisplayContext {
    if (typeof window === 'undefined') {
        return { width: 0, height: 0, dpr: 1, platform: 'unknown', userAgent: '' }
    }

    const userAgentData = (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData
    const userAgent = navigator.userAgent
    return {
        width: window.screen.width,
        height: window.screen.height,
        dpr: window.devicePixelRatio || 1,
        platform: userAgentData?.platform ?? (/android/i.test(userAgent) ? 'Android' : /iphone|ipad|ipod/i.test(userAgent) ? 'iOS' : /mac/i.test(userAgent) ? 'macOS' : /windows/i.test(userAgent) ? 'Windows' : 'unknown'),
        userAgent,
        model: userAgentData?.model,
    }
}

/** Whether this browser can ask for the experimental display-label permission. */
export function canIdentifyDisplay(): boolean {
    return typeof window !== 'undefined' && typeof (window as WindowWithScreenDetails).getScreenDetails === 'function'
}

/**
 * Requests the Window Management permission from a user gesture, then adds the OS-provided
 * display label to the browser context. The platform never exposes EDID itself, so callers
 * must treat this as an optional enhancement.
 */
export async function requestDetailedDisplayContext(): Promise<DisplayContext | null> {
    if (!canIdentifyDisplay()) return null

    const windowWithDetails = window as WindowWithScreenDetails
    const details = await windowWithDetails.getScreenDetails?.()
    const detailedScreen = details?.currentScreen
    if (!detailedScreen) return null

    return {
        ...getDisplayContext(),
        width: detailedScreen.width,
        height: detailedScreen.height,
        dpr: detailedScreen.devicePixelRatio || window.devicePixelRatio || 1,
        screenLabel: detailedScreen.label || undefined,
        isInternal: detailedScreen.isInternal,
    }
}

/** Reads the detailed display only when the user granted the permission earlier; never prompts. */
export async function getPermittedDetailedDisplayContext(): Promise<DisplayContext | null> {
    if (!canIdentifyDisplay()) return null

    try {
        const permission = await navigator.permissions.query({ name: 'window-management' } as unknown as PermissionDescriptor)
        if (permission.state !== 'granted') return null
        return await requestDetailedDisplayContext()
    } catch {
        return null
    }
}

export function estimateKnownDisplay(context: DisplayContext): DisplayEstimate {
    const screenResMatch = selectScreenResProfile(context)
    if (screenResMatch) {
        const estimate = estimateFromPanel(context, screenResMatch.profile, screenResMatch.source ?? 'screenres-profile', screenResMatch.confidence, screenResMatch.identity)
        if (estimate) return savedEstimate(context, estimate) ?? estimate
    }

    const internalEstimate = estimateFromInternalDisplayProfile(context)
    if (internalEstimate) return savedEstimate(context, internalEstimate) ?? internalEstimate

    const fallback = fallbackEstimate(context)
    return savedEstimate(context, fallback) ?? fallback
}

export function estimateFromDeviceProfiles(
    context: DisplayContext,
    profiles: Record<string, readonly [diagonalInches: number, width: number, height: number, displayName?: string]>,
    aliases: Record<string, string> = {},
    userAgentAliases: Record<string, string> = {},
): DisplayEstimate | null {
    if (context.isInternal === false) return null
    const candidates = modelCandidates(context)
    if (!candidates.length) return null

    for (const candidate of candidates) {
        const normalizedCandidate = normalizeDeviceModel(candidate)
        const profileKey = Object.hasOwn(profiles, candidate)
            ? candidate
            : aliases[normalizedCandidate] ?? userAgentAliases[normalizedCandidate]
        const profile = profileKey ? profiles[profileKey] : null
        if (!profile || !profileKey) continue

        const [diagonalInches, width, height, displayName] = profile
        const estimate = estimateFromPanel(context, {
            name: displayName ?? profileKey.replace(/^[^:]+:/, ''),
            diagonalInches,
            resolution: [width, height],
        }, 'device-profile', 'high', profileKey)
        if (estimate) return estimate
    }

    return null
}

export function estimateFromUserAgentDisplayRules(
    context: DisplayContext,
    profiles: Record<string, readonly [diagonalInches: number, width: number, height: number, displayName?: string]>,
    brandPatterns: readonly string[],
    rules: readonly (readonly [brandPatternIndex: number, modelPattern: string, model: string, requireModelTerminator?: boolean])[],
    aliases: Record<string, string> = {},
    userAgentAliases: Record<string, string> = {},
): DisplayEstimate | null {
    if (!isMobileContext(context) || !context.userAgent) return null

    const matchingBrands = new Set<number>()
    brandPatterns.forEach((pattern, index) => {
        if (userAgentPatternMatches(context.userAgent, pattern)) matchingBrands.add(index)
    })

    for (const [brandPatternIndex, modelPattern, model, requireModelTerminator] of rules) {
        if (!matchingBrands.has(brandPatternIndex) || !userAgentPatternMatches(context.userAgent, modelPattern, requireModelTerminator)) continue
        const estimate = estimateFromDeviceProfiles({ ...context, model }, profiles, aliases, userAgentAliases)
        if (estimate) return estimate
    }

    return null
}

function edidCandidates(screenLabel: string): string[] {
    const direct = compactIdentifier(screenLabel)
    const candidates = [direct, ...modelTokens(screenLabel)]
        .filter((candidate) => candidate.length >= 4 && /[a-z]/.test(candidate))
    return [...new Set(candidates)]
}

/**
 * Uses an exact OS display label to find a panel's EDID-reported physical dimensions.
 * A browser cannot read EDID directly; this only runs after the optional Window Management
 * permission makes a display label available.
 */
export function estimateFromEdidProfiles(
    context: DisplayContext,
    profiles: Record<string, readonly [label: string, widthMm: number, heightMm: number, width: number, height: number, samples: number]>,
    aliases: Record<string, string> = {},
): DisplayEstimate | null {
    if (!context.screenLabel) return null

    for (const candidate of edidCandidates(context.screenLabel)) {
        const profile = profiles[candidate] ?? profiles[aliases[candidate] ?? '']
        if (!profile) continue

        const [label, widthMm, heightMm, width, height, samples] = profile
        const ppi = ppiFromResolutionAndDimensions([width, height], widthMm, heightMm)
        if (!ppi) continue

        const estimate = estimateFromPanel(context, {
            name: label,
            diagonalInches: Math.hypot(widthMm, heightMm) / 25.4,
            resolution: [width, height],
            ppi,
        }, 'edid-profile', samples >= 3 ? 'high' : 'medium', `edid:${label}`)
        if (estimate) return estimate
    }

    return null
}

/**
 * Apple does not expose a handset model to web pages, and some Android browsers withhold it
 * too. A viewport/DPR match is still useful only when every matching physical panel agrees
 * tightly on its density. This deliberately returns null for ambiguous configurations.
 */
export function estimateFromMobileViewportProfiles(
    context: DisplayContext,
    profiles: Record<string, readonly [diagonalInches: number, width: number, height: number, displayName?: string]>,
): DisplayEstimate | null {
    if (context.isInternal === false || !isMobileContext(context) || !context.width || !context.height || !context.dpr) return null

    const [cssWidth, cssHeight] = orderedPair(context.width, context.height)
    const uniquePanels = new Map<string, PanelProfile>()

    for (const [name, [diagonalInches, width, height]] of Object.entries(profiles)) {
        const [nativeWidth, nativeHeight] = orderedPair(width, height)
        const horizontalRatio = nativeWidth / cssWidth
        const verticalRatio = nativeHeight / cssHeight
        const pixelsPerCssPixel = average([horizontalRatio, verticalRatio])
        if (!Number.isFinite(pixelsPerCssPixel) || pixelsPerCssPixel <= 0) continue
        if (Math.abs(horizontalRatio - verticalRatio) / pixelsPerCssPixel > EPSILON) continue
        if (Math.abs(pixelsPerCssPixel - context.dpr) > 0.05) continue

        const key = `${diagonalInches}:${nativeWidth}x${nativeHeight}`
        uniquePanels.set(key, { name, diagonalInches, resolution: [width, height] })
    }

    const candidates = [...uniquePanels.values()]
    if (!candidates.length) return null

    const ppis = candidates.map(profilePpi).sort((first, second) => first - second)
    const medianPpi = ppis[Math.floor(ppis.length / 2)]
    const minPpi = ppis[0]
    const maxPpi = ppis.at(-1)
    if (!medianPpi || !minPpi || !maxPpi || (maxPpi - minPpi) / medianPpi > 0.03) return null

    const representative = candidates.reduce((best, candidate) => Math.abs(profilePpi(candidate) - medianPpi) < Math.abs(profilePpi(best) - medianPpi) ? candidate : best)
    return estimateFromPanel(context, {
        ...representative,
        name: isMobileContext(context) && /iphone|ipad|ipod/i.test(`${context.platform} ${context.userAgent}`)
            ? 'matching Apple viewport profile'
            : 'matching mobile viewport profile',
    }, 'mobile-viewport-profile', candidates.length === 1 ? 'high' : 'medium')
}

async function estimateFromDeviceDatabase(context: DisplayContext): Promise<DisplayEstimate | null> {
    try {
        const { DEVICE_DISPLAY_PROFILES, DEVICE_DISPLAY_MODEL_ALIASES, DEVICE_DISPLAY_USER_AGENT_ALIASES, USER_AGENT_DISPLAY_BRAND_PATTERNS, USER_AGENT_DISPLAY_PROFILE_RULES } = await import('./data/displayProfiles.generated') as DeviceDisplayProfileModule
        return estimateFromDeviceProfiles(context, DEVICE_DISPLAY_PROFILES, DEVICE_DISPLAY_MODEL_ALIASES, DEVICE_DISPLAY_USER_AGENT_ALIASES)
            ?? estimateFromUserAgentDisplayRules(context, DEVICE_DISPLAY_PROFILES, USER_AGENT_DISPLAY_BRAND_PATTERNS, USER_AGENT_DISPLAY_PROFILE_RULES, DEVICE_DISPLAY_MODEL_ALIASES, DEVICE_DISPLAY_USER_AGENT_ALIASES)
            ?? estimateFromMobileViewportProfiles(context, DEVICE_DISPLAY_PROFILES)
    } catch {
        return null
    }
}

async function estimateFromEdidDatabase(context: DisplayContext): Promise<DisplayEstimate | null> {
    if (!context.screenLabel) return null
    try {
        const { EDID_DISPLAY_PROFILES, EDID_MODEL_ALIASES } = await import('./data/edidProfiles.generated') as EdidDisplayProfileModule
        return estimateFromEdidProfiles(context, EDID_DISPLAY_PROFILES, EDID_MODEL_ALIASES)
    } catch {
        return null
    }
}

async function getHighEntropyHints(context: DisplayContext): Promise<DisplayContext> {
    if (typeof navigator === 'undefined') return context
    const userAgentData = (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData
    if (!userAgentData?.getHighEntropyValues) return context

    try {
        const hints = await userAgentData.getHighEntropyValues(['model', 'platform'])
        return {
            ...context,
            model: hints.model || context.model,
            platform: hints.platform || context.platform,
        }
    } catch {
        return context
    }
}

/**
 * Resolves a no-network first guess. It first checks a saved per-display calibration,
 * then a CC BY ScreenRes profile, the Linux Hardware EDID panel index when an optional
 * browser display label is available, and finally the larger MIT device database for a
 * browser-supplied model, a precise mobile UA signature, or an unambiguous mobile viewport. Unknown desktop monitors intentionally retain the
 * 96 CSS-dpi baseline because resolution alone cannot reveal panel dimensions.
 */
export async function resolveDisplayEstimateForContext(context: DisplayContext): Promise<DisplayEstimate> {
    const withHints = await getHighEntropyHints(context)
    const knownEstimate = estimateKnownDisplay(withHints)
    if (knownEstimate.source === 'saved-calibration') return knownEstimate

    // `currentScreen` identifies the display that currently contains the browser window. When
    // it has a recognisable EDID label, its physical dimensions must beat a phone/laptop model
    // profile: a mobile browser can be on an external monitor and a laptop can be docked.
    const edidEstimate = await estimateFromEdidDatabase(withHints)
    if (edidEstimate) return savedEstimate(withHints, edidEstimate) ?? edidEstimate

    // A screen label can also match ScreenRes, but EDID-derived panel dimensions are the
    // stronger physical source whenever the Linux Hardware index recognizes that label.
    if (knownEstimate.source === 'screen-label-profile' || knownEstimate.source === 'screenres-model-profile') return knownEstimate

    const deviceEstimate = await estimateFromDeviceDatabase(withHints)
    if (deviceEstimate) return savedEstimate(withHints, deviceEstimate) ?? deviceEstimate
    return knownEstimate
}

export async function resolveDisplayEstimate(): Promise<DisplayEstimate> {
    return resolveDisplayEstimateForContext(getDisplayContext())
}

export function saveDisplayCalibration(context: DisplayContext, estimate: DisplayEstimate, screenScale: number): void {
    if (typeof window === 'undefined' || !Number.isFinite(screenScale) || screenScale <= 0) return

    try {
        const stored = readStoredCalibrations()
        stored.entries[estimate.signature || contextSignature(context)] = {
            ppi: screenScale * CSS_REFERENCE_PPI * estimate.pixelsPerCssPixel,
            updatedAt: new Date().toISOString(),
        }
        window.localStorage.setItem(calibrationStorageKey, JSON.stringify(stored))
        // Retain the previous key for compatibility with existing local calibrations.
        window.localStorage.setItem(legacyScreenScaleStorageKey, String(screenScale))
    } catch {
        // Private browsing or a disabled storage policy: keep the session value only.
    }
}

export function clearDisplayCalibration(estimate: DisplayEstimate): void {
    if (typeof window === 'undefined') return

    try {
        const stored = readStoredCalibrations()
        const entries = Object.fromEntries(Object.entries(stored.entries).filter(([signature]) => signature !== estimate.signature)) as Record<string, StoredDisplayCalibration>
        window.localStorage.setItem(calibrationStorageKey, JSON.stringify({ ...stored, entries }))
        window.localStorage.removeItem(legacyScreenScaleStorageKey)
    } catch {
        // Private browsing or a disabled storage policy: keep the session value only.
    }
}
