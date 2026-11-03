'use strict';

const { MAX_JSON_BODY_BYTES, PayloadTooLargeError } = require('./limits');

function readRawBody(req, limit = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { req.pause(); } catch (e) { /* 已暂停 */ }
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new PayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err));
  });
}

function parseJsonBody(req, limit = MAX_JSON_BODY_BYTES) {
  return readRawBody(req, limit).then((buf) => {
    try {
      return JSON.parse(buf.toString('utf8') || '{}');
    } catch (e) {
      return {};
    }
  });
}

module.exports = { readRawBody, parseJsonBody };
