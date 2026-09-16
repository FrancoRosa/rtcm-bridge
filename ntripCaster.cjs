const net = require('net');

const MAX_HEADER_BYTES = 8192;

/**
 * Build a minimal NTRIP sourcetable listing the single relayed mountpoint.
 */
function buildSourcetable(source) {
  const fields = [
    'STR',
    source.mountpoint,
    source.mountpoint,
    'RTCM 3',
    '',
    '',
    '',
    '',
    '',
    (source.latitude ?? 0).toFixed(4),
    (source.longitude ?? 0).toFixed(4),
    '0',
    '0',
    'ntrip-single-relay',
    'none',
    'N',
    'N',
    '9600',
    ''
  ];
  return `${fields.join(';')}\r\nENDSOURCETABLE\r\n`;
}

function parseRequest(raw) {
  const lines = raw.split('\r\n');
  const requestLine = lines[0] || '';
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  const match = requestLine.match(/^GET\s+\/?(\S*)\s+HTTP\/\d\.\d/i);
  const mountpoint = match ? decodeURIComponent(match[1]) : null;

  return { mountpoint, headers };
}

function checkAuth(headers, auth) {
  if (!auth || !auth.username) {
    return true;
  }

  const header = headers['authorization'];
  if (!header || !header.startsWith('Basic ')) {
    return false;
  }

  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    return false;
  }

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return user === auth.username && pass === auth.password;
}

/**
 * Start a minimal NTRIP caster (raw TCP, NTRIP 1.0 "ICY 200 OK" and
 * NTRIP 2.0 handshakes, sourcetable, optional Basic Auth) that relays a
 * single mountpoint. Any RTCM bytes written via `broadcast()` are fanned
 * out to every client currently streaming.
 *
 * @param {Object} options
 * @param {Object} options.source the source config ({ mountpoint, latitude, longitude })
 * @param {number} options.port TCP port to listen on
 * @param {{username: string, password: string}} [options.auth] optional downstream credentials
 * @returns {{ server: net.Server, broadcast: (data: Buffer) => void, close: () => void }}
 */
function startNtripCaster({ source, port, auth }) {
  const clients = new Set();

  const server = net.createServer((socket) => {
    let buffer = '';

    const onHandshakeData = (chunk) => {
      buffer += chunk.toString('latin1');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > MAX_HEADER_BYTES) {
          socket.destroy();
        }
        return;
      }

      socket.removeListener('data', onHandshakeData);

      const { mountpoint, headers } = parseRequest(buffer.slice(0, headerEnd));

      if (mountpoint === null) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }

      if (mountpoint === '') {
        const body = buildSourcetable(source);
        socket.end(
          `SOURCETABLE 200 OK\r\nServer: NTRIP ntrip-single-relay/1.0\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
        );
        return;
      }

      if (mountpoint !== source.mountpoint) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }

      if (!checkAuth(headers, auth)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="NTRIP"\r\nConnection: close\r\n\r\n');
        return;
      }

      const isNtrip2 = /Ntrip\/2\.0/i.test(headers['ntrip-version'] || '');
      if (isNtrip2) {
        socket.write(
          'HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: NTRIP ntrip-single-relay/1.0\r\nContent-Type: gnss/data\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n'
        );
      } else {
        // legacy NTRIP 1.0 handshake, expected by most GNSS receivers
        socket.write('ICY 200 OK\r\n\r\n');
      }

      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
      socket.on('error', () => clients.delete(socket));
      // downstream clients (rovers) may send GGA sentences; nothing to
      // do with them since this caster only relays one fixed mountpoint
      socket.on('data', () => {});
    };

    socket.on('data', onHandshakeData);
    socket.on('error', () => {});
  });

  server.listen(port, () => {
    console.log(`ntrip caster listening on ntrip://0.0.0.0:${port}/${source.mountpoint}`);
  });

  return {
    server,
    broadcast(data) {
      for (const socket of clients) {
        socket.write(data);
      }
    },
    getClientCount() {
      return clients.size;
    },
    close() {
      for (const socket of clients) {
        socket.destroy();
      }
      clients.clear();
      server.close();
    }
  };
}

module.exports = { startNtripCaster };
