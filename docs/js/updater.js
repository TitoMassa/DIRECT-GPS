import { isNative, getDirectGpsNativePlugin } from './native.js';

export const APP_VERSION = '3.1.1';
export const APP_VERSION_CODE = 311;
export const VERSION_MANIFEST_URL = 'https://titomassa.github.io/DIRECT-GPS/version.json';

const STORAGE_DISMISSED_KEY = 'directgps_update_dismissed_v1';

export function compareSemver(a = '0.0.0', b = '0.0.0') {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

export function isRemoteVersionNewer(localInfo, remoteInfo) {
  if (!remoteInfo || typeof remoteInfo !== 'object') return false;
  const rCode = Number(remoteInfo.versionCode) || 0;
  const lCode = Number(localInfo?.versionCode) || 0;
  if (rCode > 0 && lCode > 0 && rCode !== lCode) {
    return rCode > lCode;
  }
  if (remoteInfo.version && localInfo?.versionName) {
    return compareSemver(remoteInfo.version, localInfo.versionName) > 0;
  }
  return false;
}

export async function getLocalAppVersion() {
  const plugin = getDirectGpsNativePlugin();
  if (plugin?.getAppVersion) {
    try {
      const info = await plugin.getAppVersion();
      if (info?.versionName) {
        return {
          versionName: String(info.versionName),
          versionCode: Number(info.versionCode) || APP_VERSION_CODE
        };
      }
    } catch {
      // fall through
    }
  }
  return { versionName: APP_VERSION, versionCode: APP_VERSION_CODE };
}

export async function fetchRemoteVersionManifest() {
  const url = `${VERSION_MANIFEST_URL}?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function createAppUpdater({ showToast = () => {} } = {}) {
  const modal = document.getElementById('update-modal');
  const titleEl = document.getElementById('update-modal-title');
  const subEl = document.getElementById('update-modal-sub');
  const badgeEl = document.getElementById('update-version-badge');
  const notesEl = document.getElementById('update-notes-list');
  const progressWrap = document.getElementById('update-progress-wrap');
  const progressFill = document.getElementById('update-progress-fill');
  const progressText = document.getElementById('update-progress-text');
  const btnInstall = document.getElementById('btn-update-install');
  const btnLater = document.getElementById('btn-update-later');
  const btnClose = document.getElementById('btn-update-close');
  const btnBrowser = document.getElementById('btn-update-browser');
  const btnSettingsCheck = document.getElementById('btn-check-updates');
  const settingsVerLabel = document.getElementById('settings-app-version');

  let currentRemote = null;
  let currentLocal = { versionName: APP_VERSION, versionCode: APP_VERSION_CODE };
  let isDownloading = false;

  const plugin = getDirectGpsNativePlugin();
  if (plugin?.addListener) {
    try {
      plugin.addListener('apkDownloadProgress', (ev) => {
        if (!progressWrap || !progressFill || !progressText) return;
        progressWrap.classList.remove('hidden');
        const pct = Number(ev?.percent);
        if (Number.isFinite(pct) && pct >= 0) {
          progressFill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
          const mbDone = ((Number(ev?.bytesDownloaded) || 0) / (1024 * 1024)).toFixed(1);
          const mbTot = ((Number(ev?.totalBytes) || 0) / (1024 * 1024)).toFixed(1);
          progressText.textContent = `Descargando actualización... ${pct}% (${mbDone} / ${mbTot} MB)`;
        } else {
          const mbDone = ((Number(ev?.bytesDownloaded) || 0) / (1024 * 1024)).toFixed(1);
          progressText.textContent = `Descargando actualización... ${mbDone} MB`;
        }
      });
    } catch {
      // ignore
    }
  }

  function closeModal({ dismiss = false } = {}) {
    if (isDownloading) return;
    modal?.classList.add('hidden');
    if (dismiss && currentRemote?.version) {
      try {
        sessionStorage.setItem(STORAGE_DISMISSED_KEY, String(currentRemote.version));
      } catch {
        // ignore
      }
    }
  }

  function openUpdateModal(localInfo, remoteInfo) {
    if (!modal) return;
    currentLocal = localInfo;
    currentRemote = remoteInfo;
    isDownloading = false;

    if (titleEl) titleEl.textContent = 'Nueva actualización disponible';
    if (subEl) {
      subEl.textContent = remoteInfo.releaseDate
        ? `Publicada el ${remoteInfo.releaseDate} · ${isNative ? 'App Android' : 'App Web / PWA'}`
        : isNative
          ? 'Nueva versión de DIRECT GPS para Android'
          : 'Nueva versión de DIRECT GPS lista para aplicar';
    }
    if (badgeEl) {
      badgeEl.textContent = `v${localInfo.versionName} → v${remoteInfo.version}`;
    }
    if (notesEl) {
      const list = Array.isArray(remoteInfo.notes) && remoteInfo.notes.length > 0
        ? remoteInfo.notes
        : ['Mejoras de rendimiento y correcciones generales.'];
      notesEl.innerHTML = list.map((line) => `<li>${String(line).replace(/</g, '&lt;')}</li>`).join('');
    }
    if (progressWrap) progressWrap.classList.add('hidden');
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = '';

    if (btnInstall) {
      btnInstall.disabled = false;
      btnInstall.textContent = isNative ? '⬇ Descargar e instalar' : '🔄 Actualizar ahora';
    }
    if (btnBrowser) {
      const showBrowser = Boolean(isNative && (remoteInfo.apkUrl || remoteInfo.releaseUrl));
      btnBrowser.classList.toggle('hidden', !showBrowser);
      if (showBrowser) {
        btnBrowser.href = remoteInfo.apkUrl || remoteInfo.releaseUrl;
      }
    }

    modal.classList.remove('hidden');
  }

  async function applyUpdate() {
    if (!currentRemote || isDownloading) return;

    if (isNative && plugin?.downloadAndInstallApk && currentRemote.apkUrl) {
      isDownloading = true;
      if (btnInstall) {
        btnInstall.disabled = true;
        btnInstall.textContent = 'Descargando APK...';
      }
      if (progressWrap) progressWrap.classList.remove('hidden');
      if (progressFill) progressFill.style.width = '6%';
      if (progressText) progressText.textContent = 'Conectando con el servidor de actualizaciones...';

      try {
        const res = await plugin.downloadAndInstallApk({
          url: currentRemote.apkUrl,
          version: currentRemote.version || 'latest'
        });
        if (res?.status === 'permission_required') {
          isDownloading = false;
          if (btnInstall) {
            btnInstall.disabled = false;
            btnInstall.textContent = '⬇ Reintentar instalación';
          }
          if (progressWrap) progressWrap.classList.add('hidden');
          showToast(
            'Habilitá "Permitir desde esta fuente" para DIRECT GPS y volvé a tocar Descargar e instalar.',
            'warn',
            6000
          );
          return;
        }
        if (progressFill) progressFill.style.width = '100%';
        if (progressText) progressText.textContent = 'APK descargado · Confirmá la instalación en Android.';
        if (btnInstall) {
          btnInstall.disabled = false;
          btnInstall.textContent = '⬇ Volver a abrir instalador';
        }
        isDownloading = false;
      } catch (err) {
        isDownloading = false;
        if (btnInstall) {
          btnInstall.disabled = false;
          btnInstall.textContent = '⬇ Reintentar descarga';
        }
        if (progressWrap) progressWrap.classList.add('hidden');
        showToast(
          `Error al descargar APK (${err?.message || 'sin conexión'}). Podés abrir el enlace manual abajo.`,
          'warn',
          5000
        );
      }
      return;
    }

    // Web / PWA: limpiar caché del Service Worker y recargar en la versión nueva
    isDownloading = true;
    if (btnInstall) {
      btnInstall.disabled = true;
      btnInstall.textContent = 'Actualizando...';
    }
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {
      // ignore
    }
    window.location.reload();
  }

  async function checkForUpdates({ manual = false } = {}) {
    try {
      currentLocal = await getLocalAppVersion();
      if (settingsVerLabel) {
        settingsVerLabel.textContent = `v${currentLocal.versionName} (${isNative ? 'Android APK' : 'PWA'})`;
      }
      if (manual && btnSettingsCheck) {
        btnSettingsCheck.disabled = true;
        btnSettingsCheck.textContent = 'Buscando...';
      }

      const remote = await fetchRemoteVersionManifest();
      const newer = isRemoteVersionNewer(currentLocal, remote);

      if (newer) {
        let dismissedVer = '';
        try {
          dismissedVer = sessionStorage.getItem(STORAGE_DISMISSED_KEY) || '';
        } catch {
          // ignore
        }
        if (manual || dismissedVer !== String(remote.version)) {
          openUpdateModal(currentLocal, remote);
        }
        return { updateAvailable: true, local: currentLocal, remote };
      }

      if (manual) {
        showToast(`Ya tenés la última versión de DIRECT GPS (v${currentLocal.versionName})`, 'success', 3200);
      }
      return { updateAvailable: false, local: currentLocal, remote };
    } catch {
      if (manual) {
        showToast('No se pudo verificar si hay actualizaciones. Revisá tu conexión.', 'warn', 3500);
      }
      return { updateAvailable: false, local: currentLocal, remote: null };
    } finally {
      if (manual && btnSettingsCheck) {
        btnSettingsCheck.disabled = false;
        btnSettingsCheck.textContent = '🔄 Buscar actualizaciones';
      }
    }
  }

  btnInstall?.addEventListener('click', applyUpdate);
  btnLater?.addEventListener('click', () => closeModal({ dismiss: true }));
  btnClose?.addEventListener('click', () => closeModal({ dismiss: true }));
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal({ dismiss: true });
  });
  btnSettingsCheck?.addEventListener('click', () => checkForUpdates({ manual: true }));

  // Mostrar versión actual en Ajustes y chequear automáticamente al abrir + cada 4 h
  getLocalAppVersion().then((info) => {
    currentLocal = info;
    if (settingsVerLabel) {
      settingsVerLabel.textContent = `v${info.versionName} (${isNative ? 'Android APK' : 'PWA'})`;
    }
  });

  if (typeof window !== 'undefined') {
    setTimeout(() => {
      checkForUpdates({ manual: false });
    }, 2500);
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        checkForUpdates({ manual: false });
      }
    }, 4 * 60 * 60 * 1000);
  }

  return {
    checkForUpdates,
    getLocalAppVersion,
    openUpdateModal
  };
}
