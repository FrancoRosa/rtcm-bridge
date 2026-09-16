const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const selfsigned = require('selfsigned');
const { Server } = require('socket.io');
const { NtripClient } = require('ntrip-client');
const { llaToEcef } = require('./geo.cjs');
const { startNtripCaster } = require('./ntripCaster.cjs');

const settings = require('./settings-single.json');
const serverConfig = settings.server || {};
const source = settings.source;

const PUBLIC_DIR = path.join(__dirname, 'public-single');
const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

const startTime = Date.now();
let io = null;
let caster = null;
let ntripClient = null;

let totalBytes = 0;
let bytesSinceLastTick = 0;
let currentKbps = 0;
let lastDataAt = null;

setInterval(() => {
  currentKbps = (bytesSinceLastTick * 8) / 1000;
  bytesSinceLastTick = 0;
}, 1000);

function buildMetrics() {
  const now = Date.now();
  return {
    uptimeSeconds: Math.floor((now - startTime) / 1000),
    clients: {
      websocket: io ? io.of('/').sockets.size : 0,
      ntrip: caster ? caster.getClientCount() : 0
    },
    source: {
      id: source.id,
      host: source.host,
      mountpoint: source.mountpoint,
      ready: ntripClient ? ntripClient.isReady : false,
      error: ntripClient ? ntripClient.isError : false,
      closed: ntripClient ? ntripClient.isClose : false,
      kbps: Math.round(currentKbps * 10) / 10,
      totalBytes,
      lastDataAgoMs: lastDataAt ? now - lastDataAt : null
    }
  };
}

function staticHandler(req, res) {
  if (req.url === '/metrics') {
    const body = JSON.stringify(buildMetrics());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, reqPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'text/plain' });
    res.end(content);
  });
}

/**
 * Read the configured cert/key pair, generating a self-signed one on
 * disk the first time (e.g. a fresh checkout) if either file is missing.
 */
async function ensureCert(certPath, keyPath) {
  const resolvedCert = path.resolve(certPath);
  const resolvedKey = path.resolve(keyPath);

  if (fs.existsSync(resolvedCert) && fs.existsSync(resolvedKey)) {
    return {
      cert: fs.readFileSync(resolvedCert),
      key: fs.readFileSync(resolvedKey)
    };
  }

  console.log(`no TLS cert/key found, generating a self-signed one at ${resolvedCert}`);

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 3650,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ]
      }
    ]
  });

  fs.mkdirSync(path.dirname(resolvedCert), { recursive: true });
  fs.writeFileSync(resolvedCert, pems.cert);
  fs.writeFileSync(resolvedKey, pems.private);

  return { cert: pems.cert, key: pems.private };
}

async function createHttpServer() {
  const tls = serverConfig.tls;
  if (tls && tls.enabled) {
    const { cert, key } = await ensureCert(tls.cert, tls.key);
    return https.createServer({ cert, key }, staticHandler);
  }
  return http.createServer(staticHandler);
}

function startNtripClient() {
  const client = new NtripClient({
    host: source.host,
    port: source.port,
    mountpoint: source.mountpoint,
    username: source.username,
    password: source.password,
    xyz: llaToEcef(source.latitude, source.longitude, source.altitude || 0),
    interval: source.interval || 5000
  });

  client.on('data', (data) => {
    totalBytes += data.length;
    bytesSinceLastTick += data.length;
    lastDataAt = Date.now();

    io.emit('rtcm', data);
    caster.broadcast(data);
  });
  client.on('error', (err) => {
    io.emit('source-error', { source: source.id, error: String(err) });
  });
  client.on('close', () => {
    io.emit('source-closed', { source: source.id });
  });

  client.run();
  return client;
}

async function main() {
  const httpServer = await createHttpServer();
  // accept every origin
  io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    socket.emit('source', { id: source.id, host: source.host, mountpoint: source.mountpoint });
  });

  const ntripConfig = serverConfig.ntrip || {};
  caster = startNtripCaster({
    source,
    port: ntripConfig.port || 2101,
    auth: ntripConfig.username ? { username: ntripConfig.username, password: ntripConfig.password } : null
  });

  ntripClient = startNtripClient();

  const port = serverConfig.port || 8443;
  const host = serverConfig.host || '0.0.0.0';
  httpServer.listen(port, host, () => {
    const scheme = serverConfig.tls && serverConfig.tls.enabled ? 'wss' : 'ws';
    console.log(`ntrip single-source relay listening on ${scheme}://${host}:${port}`);
    console.log(`status dashboard at ${scheme === 'wss' ? 'https' : 'http'}://${host}:${port}/status.html`);
  });

  process.on('SIGINT', () => {
    ntripClient.close();
    caster.close();
    httpServer.close(() => process.exit(0));
  });
}

main();
