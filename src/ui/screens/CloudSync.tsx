import { useEffect, useRef } from 'react';
import { useOnline, useService } from '../../app/context';
import { sanitizeSettings } from '../../persistence/settings';

/**
 * Keeps account data in step across devices while signed in: game settings both
 * ways, and a copy of the offline bankroll summary for other devices to see.
 * Online chips are never touched here.
 */
export function CloudSync() {
  const online = useOnline();
  const service = useService();
  const uid = online.signedIn ? online.session?.user.id : undefined;
  const loadedFor = useRef<string | null>(null);
  const settingsJson = JSON.stringify(service.settings);
  const offline = `${service.career.bankroll}|${service.career.netProfit}|${service.career.profile.sessionsCompleted}`;

  // On sign-in, adopt the account's saved settings.
  useEffect(() => {
    if (!uid || loadedFor.current === uid) return;
    loadedFor.current = uid;
    void online.loadSettings().then((cloud) => {
      if (cloud && Object.keys(cloud).length > 0) service.updateSettings(sanitizeSettings({ ...service.settings, ...cloud }));
      else void online.saveSettings(JSON.parse(settingsJson));
    });
  }, [uid, online, service, settingsJson]);

  useEffect(() => {
    if (!uid || loadedFor.current !== uid) return;
    const id = setTimeout(() => void online.saveSettings(JSON.parse(settingsJson)), 1500);
    return () => clearTimeout(id);
  }, [uid, online, settingsJson]);

  useEffect(() => {
    if (!uid) return;
    const id = setTimeout(() => {
      const [balance, pl, sessions] = offline.split('|').map(Number);
      void online.uploadOffline({ balance, lifetimePL: pl, sessions });
    }, 2000);
    return () => clearTimeout(id);
  }, [uid, online, offline]);

  return null;
}
