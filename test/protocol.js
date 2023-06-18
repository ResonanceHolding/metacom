'use strict';

const metatests = require('metatests');
const protocol = require('../lib/protocol.js');

const { emitWarning } = process;
process.emitWarning = (warning, type, ...args) => {
  if (type === 'ExperimentalWarning') return;
  emitWarning(warning, type, ...args);
  return;
};

const packets = {
  call: {
    normal: {
      input: {
        callId: 1,
        iface: 'auth',
        ver: 1,
        method: 'signIn',
        args: { email: 'test@gmail.com', password: 'secret' },
      },
      output: {
        call: 1,
        'auth.1/signIn': { email: 'test@gmail.com', password: 'secret' },
      },
    },
    withoutVersion: {
      input: {
        callId: 1,
        iface: 'auth',
        ver: undefined,
        method: 'signIn',
        args: { email: 'test@gmail.com', password: 'secret' },
      },
      output: {
        call: 1,
        'auth/signIn': { email: 'test@gmail.com', password: 'secret' },
      },
    },
  },
  callback: {
    normal: {
      input: { callId: 1, result: { token: 'random-string' } },
      output: { callback: 1, result: { token: 'random-string' } },
    },
  },
  event: {
    normal: {
      input: {
        eventId: -1,
        iface: 'account',
        eventName: 'created',
        args: { accountId: 'random-string' },
      },
      output: {
        event: -1,
        'account/created': { accountId: 'random-string' },
      },
    },
  },
  stream: {
    initializing: {
      input: { streamId: 1, name: 'some-name', size: 1e9, status: undefined },
      output: { stream: 1, name: 'some-name', size: 1e9, status: undefined },
    },
    finalizing: {
      input: { streamId: 1, status: 'end', name: undefined, size: undefined },
      output: { stream: 1, status: 'end', name: undefined, size: undefined },
    },
    terminating: {
      input: {
        streamId: 1,
        status: 'terminate',
        name: undefined,
        size: undefined,
      },
      output: {
        stream: 1,
        status: 'terminate',
        name: undefined,
        size: undefined,
      },
    },
  },
  error: {
    normal: {
      input: { callId: 1, message: 'Invalid data', code: 400 },
      output: {
        callback: 1,
        error: { message: 'Invalid data', code: 400 },
      },
    },
    withoutCode: {
      input: { callId: 1, message: 'Invalid data', code: undefined },
      output: {
        callback: 1,
        error: { message: 'Invalid data', code: undefined },
      },
    },
  },
};

metatests.test(
  `Protocol / handles unknown packet type serialization`,
  (test) => {
    const unknownTypePacket = protocol.serialize('unknown', {});
    test.ok(!unknownTypePacket);
    test.end();
  },
);

metatests.test(`Protocol / handles empty packet deserialization`, (test) => {
  const emptyPacketData = protocol.deserialize({});
  test.strictEqual(emptyPacketData, null);
  test.end();
});

const supportedCallTypes = Object.keys(packets);
for (const type of supportedCallTypes) {
  metatests.test(
    `Protocol / handles empty ${type} packet serialization`,
    (test) => {
      test.ok(protocol.serialize(type, {}));
      test.end();
    },
  );
  const testCases = packets[type];
  for (const [caseName, packet] of Object.entries(testCases)) {
    metatests.test(
      `Protocol / serializes ${type} packet (${caseName})`,
      (test) => {
        test.strictEqual(protocol.serialize(type, packet.input), packet.output);
        test.end();
      },
    );
    metatests.test(
      `Protocol / deserializes ${type} packet (${caseName})`,
      (test) => {
        metatests.strictEqual(protocol.deserialize(packet.output), {
          type,
          data: packet.input,
        });
        test.end();
      },
    );
  }
}
