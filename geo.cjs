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

module.exports = { llaToEcef };
