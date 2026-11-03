'use strict';

import type { IncomingMessage } from 'node:http';
import type { AuthSession } from '../types';

const runtime = require('../runtime');

function getSessionFromReq(req: IncomingMessage, parsedUrl: URL | null = null): AuthSession | null {
  const authHeader = req.headers['authorization'] || '';
  let token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token && parsedUrl) {
    token = parsedUrl.searchParams.get('token') || '';
  }
  if (!token && req.headers.cookie) {
    const m = String(req.headers.cookie).match(/(?:^|;\s*)token=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  const session = runtime.authManager ? runtime.authManager.verifySession(token) : null;
  if (session) {
    session.token = token;
  }
  return session;
}

module.exports = { getSessionFromReq };
