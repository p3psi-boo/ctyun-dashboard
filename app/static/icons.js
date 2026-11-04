/** Remix Icon helpers — UI must not use emoji as icons. */
function ri(name, extraClass) {
  const cls = extraClass ? ` ${extraClass}` : '';
  return `<i class="ri-${name}${cls}" aria-hidden="true"></i>`;
}

function riLabel(name, text, extraClass) {
  return `<span class="icon-label">${ri(name, extraClass)}<span>${text}</span></span>`;
}

function statusDot(tone) {
  const t = tone || 'off';
  return `<span class="status-dot status-dot--${t}" aria-hidden="true"></span>`;
}

function statusWithText(tone, text, colorStyle) {
  const style = colorStyle ? ` style="${colorStyle}"` : '';
  return `<span class="status-with-text"${style}>${statusDot(tone)}<span>${text}</span></span>`;
}

function renderUserAvatar(el, avatar, fallbackChar) {
  if (!el) return;
  const val = (avatar || '').trim();
  if (/^ri-[a-z0-9-]+$/i.test(val)) {
    el.classList.add('avatar-has-icon');
    el.innerHTML = `<i class="${val}" aria-hidden="true"></i>`;
    return;
  }
  el.classList.remove('avatar-has-icon');
  el.textContent = val ? val.slice(0, 2) : fallbackChar;
}

function setButtonIconLabel(btn, iconName, text) {
  if (!btn) return;
  btn.innerHTML = riLabel(iconName, text);
}

function pillGuardLabel(on) {
  return `${ri('shield-check-line', 'pill-icon')}守护: ${on ? '开' : '关'}`;
}

function pillKeepLabel(text) {
  return `${ri('flashlight-line', 'pill-icon')}保活: ${text}`;
}

function pillTaskLabel(text) {
  return `${ri('focus-3-line', 'pill-icon')}任务: ${text}`;
}

function iconBtnLabel(name, text) {
  return `${ri(name, 'btn-inline-icon')} ${text}`;
}
