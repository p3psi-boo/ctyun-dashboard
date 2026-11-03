'use strict';

import type { Account, AuthSession } from '../types';

function canUserAccessAccount(session: AuthSession | null | undefined, account: Account | null | undefined): boolean {
  if (!session || !account) return false;
  if (session.role === 'admin') return true;
  return account.ownerId === session.userId;
}

module.exports = { canUserAccessAccount };
