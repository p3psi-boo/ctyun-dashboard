'use strict';

function getBeijingTimeString() {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingTimeOnly() {
  const d = new Date();
  return d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingDateOnly() {
  const d = new Date();
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

module.exports = {
  getBeijingTimeString,
  getBeijingTimeOnly,
  getBeijingDateOnly,
};
