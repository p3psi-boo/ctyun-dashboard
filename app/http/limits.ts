'use strict';

const MAX_JSON_BODY_BYTES = Math.max(16 * 1024, parseInt(process.env.MAX_JSON_BODY_BYTES, 10) || 1024 * 1024);
const MAX_IMPORT_BODY_BYTES = Math.max(MAX_JSON_BODY_BYTES, parseInt(process.env.MAX_IMPORT_BODY_BYTES, 10) || 10 * 1024 * 1024);
const MAX_PROXY_BODY_BYTES = Math.max(MAX_JSON_BODY_BYTES, parseInt(process.env.MAX_PROXY_BODY_BYTES, 10) || 5 * 1024 * 1024);

class PayloadTooLargeError extends Error {
  statusCode: number;
  limit: number;

  constructor(limit: number) {
    super(`请求体超过上限（${limit} 字节）`);
    this.name = 'PayloadTooLargeError';
    this.statusCode = 413;
    this.limit = limit;
  }
}

module.exports = {
  MAX_JSON_BODY_BYTES,
  MAX_IMPORT_BODY_BYTES,
  MAX_PROXY_BODY_BYTES,
  PayloadTooLargeError,
};
