const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { SourceManager } = require('./sourceManager.cjs');

const settings = require('./settings.cjs');
const serverConfig = settings.server || {};

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

const startTime = Date.now();
let manager = null;

function serveFile(filePath, res) {
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

function staticHandler(req, res) {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        sources: manager.metrics()
      })
    );
    return;
  }

  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, reqPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  serveFile(filePath, res);
}

function createHttpServer() {
  const tls = serverConfig.tls;
  if (tls && tls.enabled) {
    const cert = fs.readFileSync(path.resolve(tls.cert));
    const key = fs.readFileSync(path.resolve(tls.key));
    return https.createServer({ cert, key }, staticHandler);
  }
  return http.createServer(staticHandler);
}

function main() {
  const httpServer = createHttpServer();
  const io = new Server(httpServer, { cors: { origin: serverConfig.corsOrigin || '*' } });

  manager = new SourceManager(settings.sources, io);
  manager.attach();

  const port = serverConfig.port || 8443;
  const host = serverConfig.host || '0.0.0.0';
  httpServer.listen(port, host, () => {
    const scheme = serverConfig.tls && serverConfig.tls.enabled ? 'wss' : 'ws';
    console.log(`ntrip relay listening on ${scheme}://${host}:${port}`);
  });

  process.on('SIGINT', () => {
    manager.closeAll();
    httpServer.close(() => process.exit(0));
  });
}

main();
