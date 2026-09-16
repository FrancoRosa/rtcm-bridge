// WGS84 ellipsoid parameters
const WGS84_A = 6378137.0; // semi-major axis (m)
const WGS84_F = 1 / 298.257223563; // flattening
const WGS84_E2 = WGS84_F * (2 - WGS84_F); // eccentricity squared

/**
 * Convert geodetic coordinates (WGS84 lat/lon/altitude) to ECEF xyz.
 * @param {number} latDeg latitude in decimal degrees
 * @param {number} lonDeg longitude in decimal degrees
 * @param {number} altM altitude above the ellipsoid in meters
 * @returns {[number, number, number]} [x, y, z] in meters
 */
function llaToEcef(latDeg, lonDeg, altM = 0) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  const x = (n + altM) * cosLat * Math.cos(lon);
  const y = (n + altM) * cosLat * Math.sin(lon);
  const z = (n * (1 - WGS84_E2) + altM) * sinLat;

  return [x, y, z];
}

/**
 * Convert ECEF xyz back to geodetic lat/lon/altitude (WGS84), by Bowring's
 * iterative method. Used to turn an RTCM 1005/1006 antenna position back
 * into a human-readable location.
 * @param {number} x meters
 * @param {number} y meters
 * @param {number} z meters
 * @returns {{ latitude: number, longitude: number, altitude: number }}
 */
function ecefToLla(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.sqrt(x * x + y * y);

  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let alt = 0;
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    alt = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - WGS84_E2 * (n / (n + alt))));
  }

  return {
    latitude: (lat * 180) / Math.PI,
    longitude: (lon * 180) / Math.PI,
    altitude: alt
  };
}

module.exports = { llaToEcef, ecefToLla };
