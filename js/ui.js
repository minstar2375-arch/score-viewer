const toastEl = () => document.getElementById('toast');
let toastTimer;

export function toast(message, { sticky = false } = {}) {
  const el = toastEl();
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function openDialog({ title, message = '', ok, danger = false, value = null }) {
  const dlg = document.getElementById('dlg');
  const input = document.getElementById('dlgInput');
  document.getElementById('dlgTitle').textContent = title;
  document.getElementById('dlgMessage').textContent = message;
  document.getElementById('dlgMessage').hidden = !message;
  const okBtn = document.getElementById('dlgOk');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  input.hidden = value === null;
  input.required = value !== null;
  input.value = value ?? '';
  dlg.returnValue = '';
  dlg.showModal();
  if (value !== null) input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

export const confirmDialog = (opts) => openDialog(opts);

export async function promptDialog(opts) {
  const accepted = await openDialog(opts);
  return accepted ? document.getElementById('dlgInput').value.trim() : null;
}

export function initDialog() {
  const dlg = document.getElementById('dlg');
  document.getElementById('dlgCancel').addEventListener('click', () => dlg.close(''));
}
