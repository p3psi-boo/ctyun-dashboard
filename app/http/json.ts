'use strict';

import type { IncomingMessage, ServerResponse } from 'node:http';

const { corsHeadersFor } = require('./cors');
const { PayloadTooLargeError } = require('./limits');

function jsonResponse(res: ServerResponse, data: unknown, statusCode = 200, req: IncomingMessage | null = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(req ? corsHeadersFor(req) : { Vary: 'Origin' }),
  };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

function sendPayloadTooLarge(res: ServerResponse, req: IncomingMessage | null, err: any) {
  const limit = err instanceof PayloadTooLargeError ? err.limit : undefined;
  jsonResponse(res, { error: '请求体过大', limit }, 413, req);
}

module.exports = { jsonResponse, sendPayloadTooLarge };
