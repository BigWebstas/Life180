/************************************************************************/
/* UI DIalogs                                                           */
/************************************************************************/

import { t } from './i18n.js';
import { DEFAULT_ALPHA } from '../globals.js';

let _activeModal = null;

// utils/dialogs.js
let overlay = null;
let messageElement = null;
let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.id = 'window-overlay-styles';
  style.textContent = `
    #window-overlay{
      position: fixed; inset: 0; display: none;
      align-items: center; justify-content: center;
      background: rgba(0,0,0,.35);
      z-index: 2147483647;
    }
    #window-message{
      padding: 14px 18px;
      border-radius: 12px;
      border: 2px solid transparent;
      font: 600 15px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      box-shadow: 0 8px 30px rgba(0,0,0,.2);
      user-select: none;
    }`;
  document.head.appendChild(style);
  stylesInjected = true;
}

function ensureOverlay() {
  if (overlay && messageElement) return;
  injectStyles();

  overlay = document.getElementById('window-overlay');
  messageElement = document.getElementById('window-message');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'window-overlay';
    document.body.appendChild(overlay);
  }
  if (!messageElement) {
    messageElement = document.createElement('div');
    messageElement.id = 'window-message';
    messageElement.dataset.i18n = 'loading';
    messageElement.textContent = 'Loading';
    overlay.appendChild(messageElement);
  }
}

export function showWindowOverlay(
  message = 'Mensaje',
  bgColor = 'var(--l180-primary, #03a9f4)',
  textColor = 'var(--l180-on-primary, #fff)',
  borderColor = 'var(--brand-border, rgba(0,0,0,.2))',
  overlayBg = 'var(--modal-backdrop, rgba(0,0,0,.35))'
) {
  ensureOverlay();
  if (overlay.style.display === 'flex') return;

  overlay.style.background = overlayBg;
  messageElement.textContent = message;
  messageElement.style.backgroundColor = bgColor;
  messageElement.style.color = textColor;
  messageElement.style.border = `2px solid ${borderColor}`;

  overlay.style.display = 'flex';
}

export function hideWindowOverlay() {
  if (!overlay) return;
  if (overlay.style.display === 'none' || overlay.style.display === '') return;
  overlay.style.display = 'none';
}


/************************************************************************/
/* Offline banner (pinned top; click / Enter to reload)                */
/************************************************************************/

let offlineBanner = null;

function ensureOfflineBanner() {
  if (offlineBanner) return;

  const style = document.createElement('style');
  style.id = 'life180-offline-banner-styles';
  style.textContent = `
    #life180-offline-banner{
      position: fixed; top: 0; left: 0; right: 0;
      z-index: 2147483647; display: none;
      padding: 10px 16px;
      background: var(--l180-danger, #c0392b); color: #fff;
      font: 600 14px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      text-align: center; cursor: pointer; user-select: none;
      box-shadow: 0 2px 10px rgba(0,0,0,.25);
    }
    #life180-offline-banner:hover{ background: color-mix(in srgb, var(--l180-danger, #c0392b) 88%, #000); }
    #life180-offline-banner .obh{ margin-left: 6px; font-weight: 400; opacity: .85; }
  `;
  document.head.appendChild(style);

  offlineBanner = document.createElement('div');
  offlineBanner.id = 'life180-offline-banner';
  offlineBanner.setAttribute('role', 'button');
  offlineBanner.tabIndex = 0;

  const reload = () => window.location.reload();
  offlineBanner.addEventListener('click', reload);
  offlineBanner.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      reload();
    }
  });

  document.body.appendChild(offlineBanner);
}

export function showOfflineBanner(message, hint) {
  ensureOfflineBanner();
  offlineBanner.textContent = message || 'Disconnected from server';
  if (hint) {
    const span = document.createElement('span');
    span.className = 'obh';
    span.textContent = hint;
    offlineBanner.appendChild(span);
  }
  offlineBanner.style.display = 'block';
}

export function hideOfflineBanner() {
  if (offlineBanner) offlineBanner.style.display = 'none';
}



export function uiConfirm(message, opts = {}) {
    if (_activeModal)
        return Promise.resolve(false);
    _activeModal = 'confirm';
    return new Promise((resolve) => {
        const modal = buildModal({
            title: opts.title ?? t('confirmation'),
            message,
            type: opts.type ?? 'info',
            okLabel: opts.okLabel ?? t('accept'),
            cancelLabel: opts.cancelLabel ?? t('cancel'),
        });
        wireModalResolve(modal, {
            withInput: false,
            resolve
        });
        modal.focusDefault();
    });
}

export function uiPrompt(message, defaultValue = '', opts = {}) {
    if (_activeModal)
        return Promise.resolve(null);
    _activeModal = 'prompt';
    return new Promise((resolve) => {
        const modal = buildModal({
            title: opts.title ?? t('enter_value'),
            message,
            type: opts.type ?? 'info',
            withInput: true,
            inputValue: defaultValue,
			inputDisabled: opts.inputDisabled === true,
            placeholder: opts.placeholder ?? '',
            withVisibility: opts.withVisibility === true,
            visibilityValue: opts.visibilityValue !== false, // true by default
            visibilityLabel: opts.visibilityLabel || 'Mostrar en el mapa',			
            okLabel: opts.okLabel ?? t('save'),
            cancelLabel: opts.cancelLabel ?? t('cancel'),
        });
        wireModalResolve(modal, {
            withInput: true,
			withVisibility: opts.withVisibility === true,
            resolve
        });
        modal.focusDefault();
    });
}

export function uiAlert(message, opts = {}) {
    if (_activeModal)
        return Promise.resolve();
    _activeModal = 'alert';
    return new Promise((resolve) => {
        const modal = buildModal({
            title: opts.title ?? t('information'),
            message,
            type: opts.type ?? 'info',
            okLabel: opts.okLabel ?? t('accept'),
            cancelLabel: t('close'),
        });
        // For alert, hide the Cancel button if requested
        if (opts.hideCancel ?? true)
            modal.modal.querySelector('.btn-secondary')?.remove();
        wireModalResolve(modal, {
            withInput: false,
            resolve
        });
        modal.focusDefault();
    });
}

export function toast(message, {
    duration = 2500,
    type = 'info'
} = {}) {
    const { toastRoot } = ensureUiRoots();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`; // info | warning | danger | success
    el.textContent = message;
    toastRoot.appendChild(el);
    // Auto-hide
    setTimeout(() => {
        el.classList.add('hide');
        el.addEventListener('transitionend', () => el.remove(), {
            once: true
        });
    }, Math.max(1000, duration));
}

export function toRgba(hex, alpha = DEFAULT_ALPHA) {
    const h = String(hex || '').trim().toLowerCase();
    const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(h);
    const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
    const m8 = /^#([0-9a-f]{8})$/i.exec(h);
    let r,
    g,
    b;
    if (m3) {
        r = parseInt(m3[1] + m3[1], 16);
        g = parseInt(m3[2] + m3[2], 16);
        b = parseInt(m3[3] + m3[3], 16);
    } else if (m6) {
        r = parseInt(m6[1], 16);
        g = parseInt(m6[2], 16);
        b = parseInt(m6[3], 16);
    } else if (m8) {
        r = parseInt(m8[1].slice(0, 2), 16);
        g = parseInt(m8[1].slice(2, 4), 16);
        b = parseInt(m8[1].slice(4, 6), 16);
    } else
        return null;
    const a = Math.min(1, Math.max(0, Number(alpha) || 0));
    return `rgba(${r},${g},${b},${a})`;
}

function ensureUiRoots() {
    // Create containers if they do not exist
    let modalRoot = document.getElementById('ui-modal-root');
    if (!modalRoot) {
        modalRoot = document.createElement('div');
        modalRoot.id = 'ui-modal-root';
        document.body.appendChild(modalRoot);
    }
    let toastRoot = document.getElementById('ui-toast-root');
    if (!toastRoot) {
        toastRoot = document.createElement('div');
        toastRoot.id = 'ui-toast-root';
        document.body.appendChild(toastRoot);
    }
    return {
        modalRoot,
        toastRoot
    };
}

function focusTrap(container) {
    const FOCUSABLE = [
        'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
        'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])'
    ];
    const elements = container.querySelectorAll(FOCUSABLE.join(','));
    const first = elements[0];
    const last = elements[elements.length - 1];
    function onKey(e) {
        if (e.key === 'Tab' && elements.length) {
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }
    container.addEventListener('keydown', onKey);
    return () => container.removeEventListener('keydown', onKey);
}

function buildModal({
    title,
    message,
    type = 'info',
    withInput = false,
    inputValue = '',
	inputDisabled = false,
    placeholder = '',
    withVisibility = false,
    visibilityValue = true,
    visibilityLabel = 'Mostrar en el mapa',	
    okLabel,
    cancelLabel
}) {
    const { modalRoot } = ensureUiRoots();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const modal = document.createElement('div');
    modal.className = `modal modal-${type}`;

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<span class="modal-title">${title || ''}</span>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', t('close'));
    closeBtn.textContent = '×';
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const msg = document.createElement('div');
    msg.className = 'modal-message';
    msg.textContent = message || '';
    body.appendChild(msg);

    let inputEl = null;
    if (withInput) {
        inputEl = document.createElement('input');
        inputEl.className = 'modal-input';
        inputEl.type = 'text';
        inputEl.value = inputValue ?? '';
		if (inputDisabled) inputEl.disabled = true;
        if (placeholder)
            inputEl.placeholder = placeholder;
        body.appendChild(inputEl);
    }

	// Visibility checkbox: right after the label text
	let visibleEl = null;
	if (withVisibility) {
	  const row = document.createElement('div');
	  row.className = 'modal-message'; // same look as the color label

	  const lbl = document.createElement('label');
	  // Text + non-breaking space so it is not stuck to the checkbox
	  lbl.append(document.createTextNode(visibilityLabel + ' '));

	  const chk = document.createElement('input');
	  chk.type = 'checkbox';
	  chk.checked = !!visibilityValue;
	  chk.autocomplete = 'off';

	  // checkbox inside the label => sits right after the text
	  lbl.append(chk);
	  row.append(lbl);

	  body.appendChild(row);
	  visibleEl = chk;
	}

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = cancelLabel ?? t('cancel');

    const ok = document.createElement('button');
    ok.className = 'btn ' + (type === 'danger' ? 'btn-danger' : 'btn-primary');
    ok.textContent = okLabel ?? t('accept');

    actions.append(cancel, ok);
    modal.append(header, body, actions);
    overlay.appendChild(modal);
    modalRoot.appendChild(overlay);

    const removeTrap = focusTrap(modal);
    const restore = () => {
        removeTrap();
        overlay.remove();
        document.body.classList.remove('no-scroll');
        _activeModal = null;
    };

    document.body.classList.add('no-scroll');

    return {
        overlay,
        modal,
        ok,
        cancel,
        closeBtn,
        inputEl,
        visibleEl,
        focusDefault: () => {
            if (withInput && inputEl && !inputEl.disabled) {
                inputEl.focus();
            } else {
                ok.focus();
            }
        },
        destroy: restore,
    };
}

function wireModalResolve(modalObj, {
    withInput,
    withVisibility = false,
    resolve,
    reject
}) {
    const { overlay, modal, ok, cancel, closeBtn, inputEl, visibleEl, destroy } = modalObj;

    const onKey = (e) => {
        if (!_activeModal)
            return;

        if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
            return;
        }
        if (e.key === 'Enter') {
            const tag = (document.activeElement?.tagName || '').toLowerCase();
            const isTyping =
                tag === 'input' ||
                tag === 'textarea' ||
                document.activeElement?.isContentEditable;
            if (!isTyping)
                onOk();
        }
    };

    function cleanup() {
        modal.removeEventListener('keydown', onKey);
    }

    function onOk() {
        const nameVal = withInput ? (inputEl?.value ?? '') : true;
		const visVal = withVisibility ? !!visibleEl?.checked : undefined;
        cleanup();
        destroy();
        const payload = withInput ? { value: nameVal } : {};
        if (withVisibility) payload.visible = visVal;
        resolve(Object.keys(payload).length ? payload : nameVal);
    }

    function onCancel() {
        cleanup();
        destroy();
        // Mantener compatibilidad: prompt -> null, confirm/alert -> false
        resolve(withInput ? null : false);
    }

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay)
            onCancel();
    });

    // Now we listen for keys ONLY inside the modal
    modal.addEventListener('keydown', onKey);
}
