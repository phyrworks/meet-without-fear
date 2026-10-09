const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
(async () => {
  const app = express();
  app.set('trust proxy', '172.29.0.2');
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  const response = await request(app).get('/').set('X-Forwarded-For', '1.2.3.4');
  assert.notEqual(response.body.ip, '1.2.3.4', 'Direct callers must not spoof client IP');
  const trust = app.get('trust proxy fn');
  assert.equal(trust('172.29.0.2'), true);
  assert.equal(trust('172.29.0.3'), false);
  assert.equal(trust('203.0.113.1'), false);
  console.log('Proxy address and direct-client spoof rejection checks passed');
})().catch(error => { console.error(error); process.exit(1); });
