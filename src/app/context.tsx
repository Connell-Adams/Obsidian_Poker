import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { TableController } from '../session/tableController';
import type { TableView } from '../session/tableView';
import type { GameService } from './gameService';

export const ServiceContext = createContext<GameService | null>(null);

/** Access the service and re-render when its state changes. */
export function useService(): GameService {
  const service = useContext(ServiceContext);
  if (!service) throw new Error('GameService is not available');
  useSyncExternalStore(service.subscribe, service.getVersion);
  return service;
}

/** Access the service without subscribing, for components that only send commands. */
export function useServiceStatic(): GameService {
  const service = useContext(ServiceContext);
  if (!service) throw new Error('GameService is not available');
  return service;
}

/** Re-renders only when this one table changes. Other tables never trigger it. */
export function useTableView(controller: TableController): TableView {
  return useSyncExternalStore(controller.subscribe, controller.getView);
}

/** Current time updated on an interval, only while `active`. */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export type Route =
  | 'home'
  | 'play'
  | 'cash'
  | 'tournaments'
  | 'tables'
  | 'career'
  | 'stats'
  | 'coach'
  | 'history'
  | 'leaderboard'
  | 'settings';

const ROUTES: readonly Route[] = ['home', 'play', 'cash', 'tournaments', 'tables', 'career', 'stats', 'coach', 'history', 'leaderboard', 'settings'];

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(hash as Route) ? (hash as Route) : 'home';
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [route, (next) => (window.location.hash = `#/${next}`)];
}

export const go = (route: Route): void => {
  window.location.hash = `#/${route}`;
};
