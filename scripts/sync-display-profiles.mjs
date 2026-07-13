import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const database = require('node-device-detector/regexes/device-info/device')
const mobileUserAgentDatabase = require('node-device-detector/regexes/device/mobiles')
const stfDeviceDatabase = require('stf-device-db/dist/devices-latest')
const outputPath = resolve(import.meta.dirname, '../src/data/displayProfiles.generated.ts')

function parseFields(value) {
    return Object.fromEntries(
        value.split(';')
            .filter(Boolean)
            .map((field) => {
                const [key, ...rest] = field.split('=')
                return [key, rest.join('=')]
            }),
    )
}

function resolveModel(models, model, seen = new Set()) {
    if (seen.has(model)) return null
    seen.add(model)

    const value = models[model]
    if (typeof value !== 'string') return null

    const alias = value.match(/^(?:->|>-)(.+)$/)
    if (alias) return resolveModel(models, alias[1], seen)

    const fields = parseFields(value)
    const diagonalInches = Number(fields.DS)
    const resolution = fields.RS?.match(/^(\d+)x(\d+)$/)
    if (!Number.isFinite(diagonalInches) || diagonalInches <= 0 || !resolution) return null

    return {
        name: model,
        diagonalInches,
        resolution: [Number(resolution[1]), Number(resolution[2])],
    }
}

const profiles = {}
const profileEntries = []
const profilesByBrandModel = new Map()
const profileAliasesByModel = new Map()
const profileAliasesByUserAgentModel = new Map()
function profileFingerprint(profile) {
    return profile.slice(0, 3).join(':')
}

function compactIdentifier(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function profileId(brand, model) {
    return `${compactIdentifier(brand)}:${model.toLowerCase()}`
}

function profileKeyForBrandModel(brand, model) {
    const normalizedModel = normalizeProfileModel(model)
    return profilesByBrandModel.get(`${compactIdentifier(brand)}\u0000${normalizedModel}`)
        ?? uniqueProfileAliases[normalizedModel]
}

for (const [brand, models] of Object.entries(database)) {
    if (!models || typeof models !== 'object') continue

    for (const model of Object.keys(models)) {
        const resolved = resolveModel(models, model)
        if (!resolved) continue

        const key = profileId(brand, model)
        const profile = [
            resolved.diagonalInches,
            ...resolved.resolution,
            ...(resolved.name.toLowerCase() === model.toLowerCase() ? [] : [resolved.name]),
        ]
        // Keep the client-side lookup small: [panel diagonal in inches, native width, native height,
        // optional canonical product name]. Alias IDs retain the manufacturer-facing name only
        // when it differs from their lookup key, which keeps the UI useful without duplicating
        // every model string in the client bundle.
        profiles[key] = profile
        profileEntries.push({ key, brand, model: model.toLowerCase(), profile })
        profilesByBrandModel.set(`${compactIdentifier(brand)}\u0000${normalizeProfileModel(model)}`, key)

        const modelAlias = normalizeProfileModel(model)
        const aliases = profileAliasesByModel.get(modelAlias) ?? []
        aliases.push(key)
        profileAliasesByModel.set(modelAlias, aliases)

        const userAgentAlias = normalizeProfileModel(`${brand} ${model}`)
        const userAgentAliases = profileAliasesByUserAgentModel.get(userAgentAlias) ?? []
        userAgentAliases.push(key)
        profileAliasesByUserAgentModel.set(userAgentAlias, userAgentAliases)
    }
}

// OpenSTF covers carrier-specific Japanese handsets absent from node-device-detector's
// physical-spec table. Keep the carrier code and product names as aliases because they are
// the values Client Hints and Android build UAs can expose. Existing source entries win.
for (const [deviceCode, device] of Object.entries(stfDeviceDatabase)) {
    const brand = device?.maker?.name
    const display = device?.display
    const diagonalInches = Number(display?.s)
    const width = Number(display?.w)
    const height = Number(display?.h)
    if (typeof brand !== 'string' || !brand || !Number.isFinite(diagonalInches) || diagonalInches <= 0 || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) continue

    const key = profileId(brand, deviceCode)
    if (profiles[key]) continue

    const displayName = typeof device?.name?.id === 'string' && device.name.id
        ? device.name.id
        : deviceCode
    const profile = [diagonalInches, width, height, displayName]
    profiles[key] = profile

    const aliases = new Set([
        deviceCode,
        typeof device?.name?.id === 'string' ? device.name.id : '',
        typeof device?.name?.long === 'string' ? device.name.long : '',
    ].filter(Boolean))
    for (const model of aliases) {
        const normalizedModel = normalizeProfileModel(model)
        profileEntries.push({ key, brand, model: model.toLowerCase(), profile })
        const brandedModel = `${compactIdentifier(brand)}\u0000${normalizedModel}`
        if (!profilesByBrandModel.has(brandedModel)) profilesByBrandModel.set(brandedModel, key)

        const modelAliases = profileAliasesByModel.get(normalizedModel) ?? []
        modelAliases.push(key)
        profileAliasesByModel.set(normalizedModel, modelAliases)

        const userAgentAlias = normalizeProfileModel(`${brand} ${model}`)
        const userAgentAliases = profileAliasesByUserAgentModel.get(userAgentAlias) ?? []
        userAgentAliases.push(key)
        profileAliasesByUserAgentModel.set(userAgentAlias, userAgentAliases)
    }
}

const uniqueProfileAliases = Object.fromEntries(
    [...profileAliasesByModel].flatMap(([model, profileKeys]) => {
        const uniqueKeys = [...new Set(profileKeys)]
        const fingerprints = new Set(uniqueKeys.map((key) => profileFingerprint(profiles[key])))
        return fingerprints.size === 1 ? [[model, uniqueKeys[0]]] : []
    }),
)

const uniqueUserAgentProfileAliases = Object.fromEntries(
    [...profileAliasesByUserAgentModel].flatMap(([model, profileKeys]) => {
        const uniqueKeys = [...new Set(profileKeys)]
        const fingerprints = new Set(uniqueKeys.map((key) => profileFingerprint(profiles[key])))
        return fingerprints.size === 1 ? [[model, uniqueKeys[0]]] : []
    }),
)

function normalizeProfileModel(value) {
    return value.toLowerCase().replace(/_/g, ' ').replace(/ td$/i, '').trim()
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ruleCandidates = new Map()
const expandedRuleKeys = new Set()
function addUserAgentRule(brand, brandPattern, modelPattern, model) {
    if (typeof brandPattern !== 'string' || typeof modelPattern !== 'string' || typeof model !== 'string' || model.includes('$')) return
    const profileKey = profileKeyForBrandModel(brand, model)
    const profile = profiles[profileKey]
    if (!profile) return

    const ruleKey = `${brandPattern}\u0000${modelPattern}`
    const rules = ruleCandidates.get(ruleKey) ?? []
    rules.push(profileKey)
    ruleCandidates.set(ruleKey, rules)
}

/**
 * The upstream device detector represents some model names with capture groups, such as
 * `Buzz $1 Lite`. Keeping that template in the client would make an otherwise exact rule
 * select a panel that does not exist in our physical-spec index. Instead, expand it during
 * generation into literal UA model IDs and retain only variants whose resulting panel has
 * exactly the same diagonal and native resolution as the ID we matched.
 */
function addExpandedTemplateRules(brand, brandPattern, modelPattern, modelTemplate) {
    if (typeof brandPattern !== 'string' || typeof modelPattern !== 'string' || typeof modelTemplate !== 'string') return

    let matcher
    try {
        matcher = new RegExp(modelPattern, 'i')
    } catch {
        return
    }

    const brandProfiles = profileEntries.filter((entry) => compactIdentifier(entry.brand) === compactIdentifier(brand))
    for (const input of brandProfiles) {
        const match = matcher.exec(input.model)
        if (!match) continue

        const resolvedModel = normalizeProfileModel(modelTemplate.replace(/\$(\d+)/g, (_token, index) => match[Number(index)] ?? ''))
        const inputProfile = input.profile
        const resolvedProfileKey = profileKeyForBrandModel(brand, resolvedModel)
        const resolvedProfile = resolvedProfileKey ? profiles[resolvedProfileKey] : null

        // A template can be broader than the physical database (for example, a generic
        // “iPhone” capture). Do not make it a physical-size rule unless both entries are
        // the same panel. This is a strict equivalence check, not a density heuristic.
        if (!inputProfile || !resolvedProfile || profileFingerprint(inputProfile) !== profileFingerprint(resolvedProfile)) continue

        // The generated literal must be bounded at both sides. The generic runtime matcher
        // supplies the left boundary; this explicit right boundary avoids accepting a short
        // model ID as just the prefix of an unrelated identifier.
        const literalPattern = `${escapeRegExp(input.model)}(?=$|[^A-Z0-9_-])`
        addUserAgentRule(brand, brandPattern, literalPattern, resolvedModel)
        expandedRuleKeys.add(`${brandPattern}\u0000${literalPattern}`)
    }
}

for (const [brand, device] of Object.entries(mobileUserAgentDatabase)) {
    if (!device || typeof device !== 'object' || typeof device.regex !== 'string') continue
    if (Array.isArray(device.models)) {
        for (const model of device.models) {
            if (typeof model.model === 'string' && model.model.includes('$')) {
                addExpandedTemplateRules(brand, device.regex, model.regex, model.model)
            } else {
                addUserAgentRule(brand, device.regex, model.regex, model.model)
            }
        }
    } else {
        if (typeof device.model === 'string' && device.model.includes('$')) {
            addExpandedTemplateRules(brand, device.regex, device.regex, device.model)
        } else {
            addUserAgentRule(brand, device.regex, device.regex, device.model)
        }
    }
}

const brandPatterns = []
const brandPatternIndexes = new Map()
function brandPatternIndex(pattern) {
    const existing = brandPatternIndexes.get(pattern)
    if (existing !== undefined) return existing
    const index = brandPatterns.length
    brandPatterns.push(pattern)
    brandPatternIndexes.set(pattern, index)
    return index
}

const userAgentRules = []
for (const [ruleKey, profileKeys] of ruleCandidates) {
    const uniqueProfileKeys = [...new Set(profileKeys)]
    const fingerprints = new Set(uniqueProfileKeys.map((key) => profileFingerprint(profiles[key])))
    if (fingerprints.size !== 1) continue
    const [brandPattern, modelPattern] = ruleKey.split('\u0000')
    userAgentRules.push({
        rule: [brandPatternIndex(brandPattern), modelPattern, uniqueProfileKeys[0], expandedRuleKeys.has(ruleKey)],
        expanded: expandedRuleKeys.has(ruleKey),
    })
}
// Generated literals are exact and must win over a broader upstream capture-group rule (for
// example, “Buzz 1” versus “Buzz 1 Lite”). The fourth field tells the runtime to enforce a
// terminal delimiter only for these literals; upstream rules retain their own syntax.
userAgentRules.sort((first, second) => Number(second.expanded) - Number(first.expanded) || second.rule[1].length - first.rule[1].length || second.rule[0] - first.rule[0])

const banner = `/**
 * Generated by \`npm run sync-display-profiles\` from node-device-detector v2.2.6 (MIT)
 * and stf-device-db v1.2.0 (CC BY-SA 4.0).
 * Sources: https://github.com/sanchezzzhak/node-device-detector
 *          https://github.com/openstf/stf-device-db
 * Each profile uses the panel diagonal and native resolution, so PPI is derived at runtime.
 * Do not edit this file directly.
 */

export type GeneratedDeviceDisplayProfile = readonly [diagonalInches: number, width: number, height: number, displayName?: string]
export type UserAgentDisplayProfileRule = readonly [brandPatternIndex: number, modelPattern: string, model: string, requireModelTerminator?: boolean]

export const DEVICE_DISPLAY_PROFILES: Record<string, GeneratedDeviceDisplayProfile> = `

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${banner}${JSON.stringify(profiles)}\n\nexport const DEVICE_DISPLAY_MODEL_ALIASES: Record<string, string> = ${JSON.stringify(uniqueProfileAliases)}\n\nexport const DEVICE_DISPLAY_USER_AGENT_ALIASES: Record<string, string> = ${JSON.stringify(uniqueUserAgentProfileAliases)}\n\nexport const USER_AGENT_DISPLAY_BRAND_PATTERNS: readonly string[] = ${JSON.stringify(brandPatterns)}\n\nexport const USER_AGENT_DISPLAY_PROFILE_RULES: readonly UserAgentDisplayProfileRule[] = ${JSON.stringify(userAgentRules.map(({ rule }) => rule))}\n`, 'utf8')
console.info(`Wrote ${Object.keys(profiles).length} device display profiles, ${brandPatterns.length} UA vendor patterns, and ${userAgentRules.length} precise mobile UA rules to ${outputPath}`)
