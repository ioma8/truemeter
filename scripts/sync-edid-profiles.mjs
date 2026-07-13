import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const sourceDirectory = process.env.EDID_SOURCE_DIR
const outputPath = resolve(import.meta.dirname, '../src/data/edidProfiles.generated.ts')

if (!sourceDirectory) {
    throw new Error('Set EDID_SOURCE_DIR to the Digital directory of a linuxhw/EDID checkout')
}

function compactIdentifier(value) {
    return value.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '')
}

function modelTokens(value) {
    return [...value.matchAll(/[a-z]*\d[a-z0-9-]*/gi)]
        .map(([token]) => compactIdentifier(token))
        .filter((token) => token.length >= 4 && /[a-z]/.test(token))
}

function parseEdid(text) {
    const start = text.indexOf('edid-decode (hex):')
    if (start < 0) return null

    const firstBlock = text.slice(start).split(/\n\s*\n/)[1]
    const tokens = firstBlock?.match(/\b[\da-f]{2}\b/gi)
    if (!tokens || tokens.length < 128) return null

    const bytes = tokens.slice(0, 128).map((token) => Number.parseInt(token, 16))
    if (bytes[0] !== 0 || bytes[1] !== 255 || bytes[2] !== 255 || bytes[3] !== 255) return null

    const basicWidthMm = (bytes[21] ?? 0) * 10
    const basicHeightMm = (bytes[22] ?? 0) * 10

    let resolution = null
    let detailedWidthMm = null
    let detailedHeightMm = null
    let label = null
    for (let offset = 54; offset + 18 <= 126; offset += 18) {
        const pixelClock = (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8)
        if (!resolution && pixelClock) {
            const width = (bytes[offset + 2] ?? 0) + (((bytes[offset + 4] ?? 0) & 0xf0) << 4)
            const height = (bytes[offset + 5] ?? 0) + (((bytes[offset + 7] ?? 0) & 0xf0) << 4)
            const widthMm = (bytes[offset + 12] ?? 0) + (((bytes[offset + 14] ?? 0) & 0xf0) << 4)
            const heightMm = (bytes[offset + 13] ?? 0) + (((bytes[offset + 14] ?? 0) & 0x0f) << 8)
            if (width && height) {
                resolution = [width, height]
                if (widthMm && heightMm) {
                    detailedWidthMm = widthMm
                    detailedHeightMm = heightMm
                }
            }
        }

        if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 0 && bytes[offset + 3] === 0xfc) {
            const value = String.fromCharCode(...bytes.slice(offset + 5, offset + 18)).replace(/[\0\n\r]+/g, '').trim()
            if (value) label = value
        }
    }

    const widthMm = detailedWidthMm ?? basicWidthMm
    const heightMm = detailedHeightMm ?? basicHeightMm
    return label && resolution && widthMm && heightMm ? { label, widthMm, heightMm, resolution } : null
}

const paths = await readdir(sourceDirectory, { recursive: true })
const files = paths.filter((path) => !path.includes('.') && !path.endsWith('/'))
const candidates = new Map()

for (let index = 0; index < files.length; index += 400) {
    const batch = files.slice(index, index + 400)
    const records = await Promise.all(batch.map(async (path) => {
        try {
            return parseEdid(await readFile(resolve(sourceDirectory, path), 'utf8'))
        } catch {
            return null
        }
    }))

    for (const record of records) {
        if (!record) continue
        const key = compactIdentifier(record.label)
        if (key.length < 4) continue
        const fingerprint = `${record.widthMm}x${record.heightMm}:${record.resolution.join('x')}`
        const existing = candidates.get(key) ?? { label: record.label, samples: new Map() }
        existing.samples.set(fingerprint, (existing.samples.get(fingerprint) ?? 0) + 1)
        candidates.set(key, existing)
    }
}

const profiles = {}
for (const [key, candidate] of candidates) {
    const ranked = [...candidate.samples.entries()].sort((first, second) => second[1] - first[1])
    const [fingerprint, count] = ranked[0] ?? []
    const total = ranked.reduce((sum, [, occurrences]) => sum + occurrences, 0)
    if (!fingerprint || !count || count / total < 0.8) continue

    const [size, resolution] = fingerprint.split(':')
    const [widthMm, heightMm] = size.split('x').map(Number)
    const [width, height] = resolution.split('x').map(Number)
    profiles[key] = [candidate.label, widthMm, heightMm, width, height, count]
}

// Operating systems sometimes expose only a model token ("U2723QE") while the EDID
// descriptor includes its vendor ("DELL U2723QE"). Add only aliases that resolve to one
// physical panel fingerprint, never a fuzzy or ambiguous model name.
const aliases = new Map()
for (const [key, [label, widthMm, heightMm, width, height]] of Object.entries(profiles)) {
    const fingerprint = `${widthMm}x${heightMm}:${width}x${height}`
    for (const alias of modelTokens(label)) {
        const entries = aliases.get(alias) ?? []
        entries.push([key, fingerprint])
        aliases.set(alias, entries)
    }
}
const modelAliases = {}
for (const [alias, entries] of aliases) {
    if (profiles[alias]) continue
    const fingerprints = new Set(entries.map(([, fingerprint]) => fingerprint))
    if (fingerprints.size !== 1) continue
    const [key] = entries[0]
    modelAliases[alias] = key
}

const banner = `/**
 * Generated by \`EDID_SOURCE_DIR=/path/to/EDID/Digital npm run sync-edid-profiles\`.
 * Source: Linux Hardware EDID repository (https://github.com/linuxhw/EDID), CC BY 4.0.
 * Entries retain only monitor labels, native timing, and physical panel dimensions. Detailed-timing
 * dimensions (millimetre precision) are preferred over the EDID base block's centimetre field.
 * Unambiguous model-token aliases are included for OS labels that omit a manufacturer prefix.
 * Do not edit this file directly.
 */

export type EdidDisplayProfile = readonly [label: string, widthMm: number, heightMm: number, width: number, height: number, samples: number]

export const EDID_DISPLAY_PROFILES: Record<string, EdidDisplayProfile> = `

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${banner}${JSON.stringify(profiles)}\n\nexport const EDID_MODEL_ALIASES: Record<string, string> = ${JSON.stringify(modelAliases)}\n`, 'utf8')
console.info(`Wrote ${Object.keys(profiles).length} canonical EDID profiles and ${Object.keys(modelAliases).length} model aliases to ${outputPath}`)
