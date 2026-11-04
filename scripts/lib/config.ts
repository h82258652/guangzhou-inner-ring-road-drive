/** Shared configuration for the data pipeline. Bounding boxes are south,west,north,east. */
export const CACHE_DIR = 'scripts/.cache';
export const OUT_DIR = 'public/data';

/** Expressways (inner ring + ramps + connectors). */
export const BBOX_EXPRESS = [23.07, 113.21, 23.18, 113.33] as const;
/** Detailed city (buildings, streets, water, parks) around the ring. */
export const BBOX_CITY = [23.08, 113.205, 23.17, 113.325] as const;
/** Distant skyline (tall buildings only). */
export const BBOX_SKYLINE = [23.04, 113.17, 23.22, 113.42] as const;

/** Local tangent-plane origin (roughly the centre of the ring). */
export const ORIGIN = { lat: 23.125, lon: 113.27 } as const;

/** Reference point where arc length s = 0 on both lines (Guangzhou Railway Station, 环市西路). */
export const STATION_REF = { lat: 23.1478, lon: 113.2575 } as const;
