'use strict';

function getBeijingTimeString(): string {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingTimeOnly(): string {
  const d = new Date();
  return d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingDateOnly(): string {
  const d = new Date();
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

module.exports = {
  getBeijingTimeString,
  getBeijingTimeOnly,
  getBeijingDateOnly,
};
