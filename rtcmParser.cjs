const { ecefToLla } = require('./geo.cjs');

/** Reads consecutive bit fields out of a Buffer, MSB-first. */
class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.bitPos = 0;
  }

  readUnsignedBits(n) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byteIndex = this.bitPos >> 3;
      const bitIndex = 7 - (this.bitPos & 7);
      const bit = (this.buffer[byteIndex] >> bitIndex) & 1;
      // regular multiply/add, not bitwise shift: fields go up to 38 bits,
      // beyond what JS's 32-bit bitwise operators can hold
      value = value * 2 + bit;
      this.bitPos++;
    }
    return value;
  }

  readSignedBits(n) {
    const raw = this.readUnsignedBits(n);
    const halfRange = 2 ** (n - 1);
    return raw >= halfRange ? raw - 2 ** n : raw;
  }
}

/**
 * Parse one already-framed, CRC-validated RTCM v3 message (as produced by
 * ntrip-decoder's `data` event: 0xD3 preamble + 10-bit length + payload +
 * 24-bit CRC). Only message types 1005/1006 ("Stationary RTK Reference
 * Station ARP") are decoded in detail, since they carry the broadcasting
 * base's station ID and antenna position - everything else just gets its
 * message type identified.
 *
 * @param {Buffer} frame
 * @returns {{ messageType: number, stationId?: number, latitude?: number, longitude?: number, altitude?: number, antennaHeight?: number } | null}
 */
function parseRtcmFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame[0] !== 0xd3) {
    return null;
  }

  const length = ((frame[1] & 0x03) << 8) | frame[2];
  const payload = frame.subarray(3, 3 + length);
  if (payload.length < 2) {
    return null;
  }

  const reader = new BitReader(payload);
  const messageType = reader.readUnsignedBits(12);

  if (messageType !== 1005 && messageType !== 1006) {
    return { messageType };
  }

  const minBytes = messageType === 1006 ? 21 : 19;
  if (payload.length < minBytes) {
    return { messageType };
  }

  const stationId = reader.readUnsignedBits(12);
  reader.readUnsignedBits(6); // ITRF realization year
  reader.readUnsignedBits(1); // GPS indicator
  reader.readUnsignedBits(1); // GLONASS indicator
  reader.readUnsignedBits(1); // Galileo / reserved indicator
  reader.readUnsignedBits(1); // reference-station indicator
  const x = reader.readSignedBits(38) * 0.0001;
  reader.readUnsignedBits(1); // single receiver oscillator indicator
  reader.readUnsignedBits(1); // reserved
  const y = reader.readSignedBits(38) * 0.0001;
  reader.readUnsignedBits(2); // quarter cycle indicator
  const z = reader.readSignedBits(38) * 0.0001;

  let antennaHeight = null;
  if (messageType === 1006) {
    antennaHeight = reader.readUnsignedBits(16) * 0.0001;
  }

  const lla = ecefToLla(x, y, z);

  return {
    messageType,
    stationId,
    latitude: lla.latitude,
    longitude: lla.longitude,
    altitude: lla.altitude,
    antennaHeight
  };
}

module.exports = { parseRtcmFrame, BitReader };
