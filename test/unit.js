'use strict';

const tests = ['events', 'client', 'server', 'streams', 'protocol'];

for (const test of tests) require(`./${test}.js`);
