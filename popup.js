const api = globalThis.browser ?? globalThis.chrome;
const ALL_SITES = { origins: ['<all_urls>'] };
const $ = (id) => document.getElementById(id);

async function refreshCount() {
  $('count').textContent = (await ConsoleDB.count()).toLocaleString('pt-BR');
  const { usage } = await navigator.storage.estimate();
  const [n, unit] = usage >= 1048576 ? [usage / 1048576, 'MB'] : [usage / 1024, 'KB'];
  $('usage').textContent = `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${unit} no disco`;
}

async function init() {
  const settings = await api.storage.local.get({ enabled: true, captureNetwork: true, captureSurface: true, captureRuntime: true, captureTaint: true });
  for (const key of ['enabled', 'captureNetwork', 'captureSurface', 'captureRuntime', 'captureTaint']) {
    $(key).checked = settings[key];
    $(key).addEventListener('change', () => api.storage.local.set({ [key]: $(key).checked }));
  }

  // The recording switch shows its state in words: "Gravando" (green) vs "Pausado" (grey).
  const syncEnabledLabel = () => {
    const on = $('enabled').checked;
    $('enabledLabel').textContent = on ? 'Gravando' : 'Pausado';
    $('enabledLabel').className = on ? 'on' : 'off';
  };
  $('enabled').addEventListener('change', syncEnabledLabel);
  syncEnabledLabel();

  // Firefox treats MV3 host permissions as optional, so they may not be granted yet.
  if (!(await api.permissions.contains(ALL_SITES))) $('perm').style.display = 'block';
  $('grant').addEventListener('click', async () => {
    if (await api.permissions.request(ALL_SITES)) $('perm').style.display = 'none';
  });

  $('open').addEventListener('click', () => {
    api.tabs.create({ url: api.runtime.getURL('viewer.html') });
    window.close();
  });

  // Popups can't use confirm() in Firefox, so ask with a second click instead.
  let armed = false;
  $('clear').addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      $('clear').textContent = 'Confirmar?';
      return;
    }
    await Promise.all([ConsoleDB.clear(), ConsoleDB.surfaceClear(), ConsoleDB.runtimeClear()]);
    armed = false;
    $('clear').textContent = 'Limpar';
    refreshCount();
  });

  refreshCount();
}

init();
