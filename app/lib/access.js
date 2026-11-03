'use strict';

function canUserAccessAccount(session, account) {
  if (!session || !account) return false;
  if (session.role === 'admin') return true;
  return account.ownerId === session.userId;
}

module.exports = { canUserAccessAccount };
