/**
 * Common Apple built-in panels. Values are native panel pixels and PPI from Apple technical
 * specifications. These are used only after the Window Management API confirms an internal
 * display, so an external monitor with the same resolution is never treated as a MacBook panel.
 */
export interface InternalDisplayProfile {
    name: string
    resolution: readonly [number, number]
    ppi: number
}

export const APPLE_INTERNAL_DISPLAY_PROFILES: readonly InternalDisplayProfile[] = [
    { name: 'MacBook Retina 12-inch', resolution: [2304, 1440], ppi: 226 },
    { name: 'MacBook Retina 13-inch', resolution: [2560, 1600], ppi: 227 },
    { name: 'MacBook Retina 15-inch', resolution: [2880, 1800], ppi: 220 },
    { name: 'MacBook Pro Retina 16-inch (2019)', resolution: [3072, 1920], ppi: 226 },
    { name: 'MacBook Air 13-inch (2022 and later)', resolution: [2560, 1664], ppi: 224 },
    { name: 'MacBook Air 15-inch (2023 and later)', resolution: [2880, 1864], ppi: 224 },
    { name: 'MacBook Pro 14-inch (2021 and later)', resolution: [3024, 1964], ppi: 254 },
    { name: 'MacBook Pro 16-inch (2021 and later)', resolution: [3456, 2234], ppi: 254 },
]
