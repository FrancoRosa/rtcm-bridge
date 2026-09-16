const { NtripClient } = require('ntrip-client');
const { llaToEcef } = require('./geo.cjs');
const settings = require('./settings.cjs');

// quick standalone test of a single source; pass its key as argv[2],
// defaults to the first entry in settings.cjs. For serving multiple
// sources over socket.io, use server.cjs instead.
const sourceKey = process.argv[2];
const source = sourceKey
  ? settings.sources.find((s) => s.key === sourceKey)
  : settings.sources[0];

if (!source) {
  throw new Error(`unknown source: ${sourceKey}`);
}

const options = {
  host: source.host,
  port: source.port,
  mountpoint: source.mountpoint,
  username: source.username,
  password: source.password,
  xyz: llaToEcef(source.latitude, source.longitude, source.altitude),
  // the interval of send nmea, unit is millisecond
  interval: source.interval,
};

const client = new NtripClient(options);

client.on('data', (data) => {
  console.log(data.toString());
});

client.on('close', () => {
  console.log('client close');
});

client.on('error', (err) => {
  console.log(err);
});

client.run();