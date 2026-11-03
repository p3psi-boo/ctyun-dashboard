'use strict';

const runtime = require('../runtime');

function getSessionFromReq(req, parsedUrl = null) {
  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token && parsedUrl) {
    token = parsedUrl.searchParams.get('token') || '';
  }
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  const session = runtime.authManager ? runtime.authManager.verifySession(token) : null;
  if (session) {
    session.token = token;
  }
  return session;
}

module.exports = { getSessionFromReq };
