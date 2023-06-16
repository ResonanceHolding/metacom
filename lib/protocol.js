'use strict';

const serializer = {
  call: ({ callId, iface, ver, method, args }) => ({
    call: callId,
    [`${iface}${ver ? `.${ver}` : ''}/${method}`]: args,
  }),
  callback: ({ callId, result }) => ({ callback: callId, result }),
  event: ({ eventId, iface, eventName, args }) => ({
    event: eventId,
    [`${iface}/${eventName}`]: args,
  }),
  stream: ({ streamId, name, size, status }) => ({
    stream: streamId,
    name,
    size,
    status,
  }),
  error: ({ callId, message, code }) => ({
    callback: callId,
    error: { message, code },
  }),
};

const serialize = (type, data) => serializer[type]?.(data) ?? null;

const deserializer = {
  call: ({ call, ...data }) => {
    const target = Object.keys(data).at(0);
    const [service, method] = target?.split('/') ?? [];
    const [iface, ver] = service?.split('.') ?? [];
    return {
      callId: call,
      iface,
      method,
      ver: ver && parseInt(ver),
      args: data[target],
    };
  },
  callback: ({ callback, result }) => ({ callId: callback, result }),
  event: ({ event, ...data }) => {
    const target = Object.keys(data).at(0);
    const [iface, eventName] = target?.split('/') ?? [];
    return { eventId: event, iface, eventName, args: data[target] };
  },
  stream: ({ stream, name, size, status }) => ({
    streamId: stream,
    name,
    size,
    status,
  }),
  error: ({ callback, error }) => ({
    callId: callback,
    message: error?.message,
    code: error?.code,
  }),
};

const deserialize = (packet) => {
  const type = packet.error ? 'error' : Object.keys(packet).at(0);
  if (!type) return null;
  const data = deserializer[type](packet);
  return { type, data };
};

module.exports = {
  serialize,
  deserialize,
  serializer,
  deserializer,
};
