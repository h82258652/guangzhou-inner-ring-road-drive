/**
 * Local tangent-plane projection used by both the data pipeline and the game.
 *
 * World axes: +X = east, +Z = south, +Y = up (so north is -Z, matching a
 * top-down map when the camera's up vector is -Z). Units are metres.
 */
export interface LatLon {
  lat: number;
  lon: number;
}

export class LocalProjection {
  readonly mPerDegLat: number;
  readonly mPerDegLon: number;

  constructor(readonly origin: LatLon) {
    const phi = (origin.lat * Math.PI) / 180;
    this.mPerDegLat = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
    this.mPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
  }

  /** Returns [x, z] in metres. */
  project(lat: number, lon: number): [number, number] {
    return [(lon - this.origin.lon) * this.mPerDegLon, -(lat - this.origin.lat) * this.mPerDegLat];
  }

  unproject(x: number, z: number): LatLon {
    return { lat: this.origin.lat - z / this.mPerDegLat, lon: this.origin.lon + x / this.mPerDegLon };
  }
}
