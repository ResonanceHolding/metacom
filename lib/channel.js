'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');
const metautil = require('metautil');
const { MetaReadable, MetaWritable, Chunk } = require('./streams.js');
const protocol = require('./protocol.js');

const EMPTY_PACKET = Buffer.from('{}');

const createProxy = (data, save) =>
  new Proxy(data, {
    get: (data, key) => {
      return Reflect.get(data, key);
    },
    set: (data, key, value) => {
      const res = Reflect.set(data, key, value);
      if (save) save(data);
      return res;
    },
  });

class Session {
  constructor(token, channel, data) {
    this.token = token;
    this.state = createProxy(data, (data) => {
      channel.auth.saveSession(token, data).catch(channel.console.error);
    });
  }
}

const sessions = new Map(); // token: Session

class Context {
  constructor(channel) {
    this.client = channel.client;
    this.uuid = metautil.generateUUID();
    this.state = {};
    this.session = channel?.session || null;
  }
}

class Client extends EventEmitter {
  #channel;

  constructor(channel) {
    super();
    this.#channel = channel;
    this.auth = channel.auth;
  }

  redirect(location) {
    if (this.#channel) this.#channel.redirect(location);
  }

  get ip() {
    return this.#channel ? this.#channel.ip : undefined;
  }

  emit(name, data) {
    if (name === 'close') {
      super.emit(name, data);
      return;
    }
    this.#channel.sendEvent(name, data);
  }

  getStream(streamId) {
    return this.#channel.getStream(streamId);
  }

  createStream(name, size) {
    return this.#channel.createStream(name, size);
  }

  initializeSession(token, data = {}) {
    if (this.#channel.session) sessions.delete(this.#channel.session.token);
    const session = new Session(token, this.#channel, data);
    this.#channel.session = session;
    sessions.set(token, session);
    return true;
  }

  finalizeSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    if (!this.#channel.session) return false;
    sessions.delete(this.#channel.session.token);
    this.#channel.session = null;
    return true;
  }

  startSession(token, data = {}) {
    this.initializeSession(token, data);
    if (!this.#channel.connection) this.#channel.sendSessionCookie(token);
    return true;
  }

  restoreSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    if (!this.#channel) return false;
    this.#channel.session = session;
    return true;
  }
}

class Channel {
  constructor(server, req, res) {
    this.server = server;
    this.auth = server.application.auth;
    this.console = server.application.console;
    this.req = req;
    this.res = res;
    this.ip = req.socket.remoteAddress;
    this.client = new Client(this);
    this.session = null;
    this.eventId = 0;
    this.streamId = 0;
    this.streams = new Map();
  }

  get token() {
    if (this.session === null) return '';
    return this.session.token;
  }

  message(msg) {
    if (Buffer.compare(EMPTY_PACKET, msg) === 0) {
      this.send('{}');
      return;
    }
    const packet = metautil.jsonParse(msg);
    if (!packet) {
      const error = new Error('JSON parsing error');
      this.error(500, { error, pass: true });
      return;
    }
    const { type, data } = protocol.deserialize(packet);
    if (!type) {
      const error = new Error('Packet structure error');
      this.error(500, { error, pass: true });
      return;
    }
    const handler = this[`${type}Handler`];
    if (!handler) return;
    handler(data);
  }

  binary(data) {
    try {
      const { streamId, payload } = Chunk.decode(data);
      const upstream = this.streams.get(streamId);
      if (upstream) {
        upstream.push(payload);
      } else {
        const error = new Error(`Stream ${streamId} is not initialized`);
        this.error(400, { callId: streamId, error, pass: true });
      }
    } catch (error) {
      this.error(400, { callId: 0, error });
    }
  }

  callHandler({ callId, iface, method, ver, args }) {
    this.resumeCookieSession();
    if (!callId || !iface || !method || !args) {
      const error = new Error('Packet structure error');
      this.error(400, { callId, error, pass: true });
      return;
    }
    void this.rpc(callId, iface, ver, method, args);
  }

  async streamHandler({ streamId, name, size, status }) {
    const stream = this.streams.get(streamId);
    if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
      if (stream) {
        const error = new Error(`Stream ${name} is already initialized`);
        this.error(400, { callId: streamId, error, pass: true });
      } else {
        const streamData = { streamId, name, size };
        const stream = new MetaReadable(streamData);
        this.streams.set(streamId, stream);
      }
    } else if (!stream) {
      const error = new Error(`Stream ${streamId} is not initialized`);
      this.error(400, { callId: streamId, error, pass: true });
    } else if (status === 'end') {
      await stream.close();
      this.streams.delete(streamId);
    } else if (status === 'terminate') {
      await stream.terminate();
      this.streams.delete(streamId);
    } else {
      const error = new Error('Stream packet structure error');
      this.error(400, { callId: streamId, error, pass: true });
    }
  }

  createContext() {
    return new Context(this);
  }

  async rpc(callId, iface, ver, method, args) {
    const { server, console } = this;
    const proc = server.application.getMethod(iface, ver, method);
    if (!proc) {
      this.error(404, { callId });
      return;
    }
    const context = this.createContext();
    if (!this.session && proc.access !== 'public') {
      this.error(403, { callId });
      return;
    }
    try {
      await proc.enter();
    } catch {
      this.error(503, { callId });
      return;
    }
    let result = null;
    try {
      context.accountId = this.session?.state?.accountId;
      result = await proc.invoke(context, args);
    } catch (error) {
      if (error.message === 'Timeout reached') {
        error.code = error.httpCode = 408;
      }
      this.error(error.code, { callId, error });
      return;
    } finally {
      proc.leave();
    }
    if (result?.constructor?.name === 'Error') {
      const { code, httpCode } = result;
      this.error(code, { callId, error: result, httpCode: httpCode || 200 });
      return;
    }
    const packet = protocol.serialize('callback', { callId, result });
    this.send(packet);
    console.log(`${this.ip}\t${iface}/${method}`);
  }

  error(code = 500, { callId, error = null, httpCode = null } = {}) {
    const { console, req, ip } = this;
    const { url, method } = req;
    if (!httpCode) httpCode = (error && error.httpCode) || code;
    const status = http.STATUS_CODES[httpCode];
    const pass = httpCode < 500 || httpCode > 599;
    const message = pass && error ? error.message : status || 'Unknown error';
    const reason = `${httpCode}\t${code}\t${error ? error.stack : status}`;
    console.error(`${ip}\t${method}\t${url}\t${reason}`);
    const packet = protocol.serialize('error', { callId, message, code });
    this.send(packet, httpCode);
  }

  // `iface` and `eventName` should be received as arg, instead of concatinated version as `name`
  // since this concatination step is part of serialization
  sendEvent(name, args) {
    if (!this.connection) throw new Error("Transport doesn't support events");
    // doint this since in current protocol version it will work:)
    const [iface, eventName] = name.split('/');
    const packet = protocol.serialize('event', {
      eventId: --this.eventId,
      iface,
      eventName,
      args,
    });
    this.send(packet);
  }

  getStream(streamId) {
    if (!this.connection) throw new Error("Transport doesn't support streams");
    const stream = this.streams.get(streamId);
    if (stream) return stream;
    throw new Error(`Stream ${streamId} is not initialized`);
  }

  createStream(name, size) {
    if (!this.connection) throw new Error("Transport doesn't support streams");
    if (!name) throw new Error('Stream name is not provided');
    if (!size) throw new Error('Stream size is not provided');
    const streamId = --this.streamId;
    const initData = { streamId, name, size };
    const transport = this.connection;
    return new MetaWritable(transport, initData);
  }

  async resumeCookieSession() {
    const { cookie } = this.req.headers;
    if (!cookie) return;
    const cookies = metautil.parseCookies(cookie);
    const { token } = cookies;
    if (!token) return;
    const restored = this.client.restoreSession(token);
    if (restored) return;
    const data = await this.auth.readSession(token);
    if (data) this.client.initializeSession(token, data);
  }

  destroy() {
    this.client.emit('close');
    if (!this.session) return;
    sessions.delete(this.session.token);
  }
}

module.exports = { Channel };
