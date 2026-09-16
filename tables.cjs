const { NtripClient } = require('ntrip-client');
const settings = require('./settings.jsonc');

const options = {
  host: settings.host,
  port: settings.port,
  mountpoint: '',
  username: settings.username,
  password: settings.password
};

const client = new NtripClient(options);

client.on('data', (data) => {
  console.log(data);
});

client.on('close', () => {
  console.log('client close');
});

client.on('error', (err) => {
  console.log(err);
});

client.run();