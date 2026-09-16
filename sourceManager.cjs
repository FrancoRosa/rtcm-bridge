const { NtripClient } = require('ntrip-client');
const { llaToEcef } = require('./geo.cjs');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Maps each configured source to its own socket.io namespace, named
 * after the source's `key` (e.g. a source with key "minneapolis" is
 * reached at namespace "/minneapolis" - connecting a socket.io client
 * to `wss://host/minneapolis` gets exactly that source's RTCM stream,
 * nothing else). Every source's upstream NtripClient is connected as
 * soon as the manager is created and stays connected for the life of
 * the process, independent of whether anyone is watching.
 */
class SourceManager {
  /**
   * @param {Array} sources source configs from settings.cjs (each needs a unique `key`)
   * @param {import('socket.io').Server} io
   */
  constructor(sources, io) {
    this.io = io;
    this.entries = new Map(
      sources.map((source) => [
        source.key,
        {
          source,
          client: null,
          subscriberCount: 0,
          totalBytes: 0,
          bytesSinceLastTick: 0,
          kbps: 0,
          lastDataAt: null
        }
      ])
    );

    this._rateTicker = setInterval(() => this._tickRates(), 1000);
  }

  /**
   * Wire up the dynamic namespace matcher and connect every source's
   * upstream caster; call once at startup. The regex matcher MUST be
   * registered before any `/key` namespace is created (which `_start`
   * does via `io.of`) - socket.io only routes a connecting client
   * through the regex-matched parent namespace (and so through the
   * "connection" listener below, which counts subscribers) the first
   * time that namespace name is created. Creating it earlier makes
   * socket.io reuse a plain, uncounted namespace for every real
   * connection instead.
   */
  attach() {
    if (this.entries.size === 0) {
      return;
    }
    const keys = [...this.entries.keys()].map(escapeRegExp);
    const pattern = new RegExp(`^/(?:${keys.join('|')})$`);

    this.io.of(pattern).on('connection', (socket) => {
      const key = socket.nsp.name.slice(1);
      const entry = this.entries.get(key);
      entry.subscriberCount += 1;
      socket.on('disconnect', () => {
        entry.subscriberCount -= 1;
      });
    });

    for (const [key, entry] of this.entries) {
      this._start(key, entry);
    }
  }

  /** @returns {Array} per-source health/traffic snapshot, for a status page */
  metrics() {
    const now = Date.now();
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      host: entry.source.host,
      mountpoint: entry.source.mountpoint,
      clients: entry.subscriberCount,
      ready: entry.client ? entry.client.isReady : false,
      error: entry.client ? entry.client.isError : false,
      kbps: entry.kbps,
      totalBytes: entry.totalBytes,
      lastDataAgoMs: entry.lastDataAt ? now - entry.lastDataAt : null
    }));
  }

  _start(key, entry) {
    const source = entry.source;
    const client = new NtripClient({
      host: source.host,
      port: source.port,
      mountpoint: source.mountpoint,
      username: source.username,
      password: source.password,
      xyz: llaToEcef(source.latitude, source.longitude, source.altitude || 0),
      interval: source.interval || 5000
    });

    const namespace = this.io.of(`/${key}`);

    client.on('data', (data) => {
      entry.totalBytes += data.length;
      entry.bytesSinceLastTick += data.length;
      entry.lastDataAt = Date.now();
      namespace.emit('rtcm', data);
    });
    client.on('error', (err) => {
      namespace.emit('source-error', { source: key, error: String(err) });
    });
    client.on('close', () => {
      namespace.emit('source-closed', { source: key });
    });

    client.run();
    entry.client = client;
  }

  _tickRates() {
    for (const entry of this.entries.values()) {
      entry.kbps = Math.round(((entry.bytesSinceLastTick * 8) / 1000) * 10) / 10;
      entry.bytesSinceLastTick = 0;
    }
  }

  /** close every running upstream connection, e.g. on server shutdown */
  closeAll() {
    clearInterval(this._rateTicker);
    for (const entry of this.entries.values()) {
      if (entry.client) {
        entry.client.close();
      }
    }
  }
}

module.exports = { SourceManager };
