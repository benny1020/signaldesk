import { useEffect, useState, useRef, type MouseEvent } from 'react';
import { ChevronDown, Search, ArrowUpRight, Menu, Boxes } from 'lucide-react';
import { Dialog } from './components';
import {
  navigationGroups,
  navigationGroup,
  navigationHref,
  matchesNavigation,
  type NavigationService,
} from './navigation-model';

type NavigationProps = {
  page: string;
  url: URLSearchParams;
  navigate: (page: string) => void;
  firing: number;
};
function go(
  event: MouseEvent<HTMLAnchorElement>,
  page: string,
  navigate: NavigationProps['navigate'],
) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(page);
}
export function GroupedNavigation(p: NavigationProps) {
  const current = navigationGroup(p.page);
  const [expanded, setExpanded] = useState<string | null>(current.key);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => setExpanded(current.key), [current.key, p.page]);
  useEffect(() => {
    const container = nav.current,
      active = container?.querySelector('a[aria-current="page"]');
    if (!container || !active?.getClientRects().length) return;
    const bounds = container.getBoundingClientRect(),
      item = active.getBoundingClientRect();
    if (item.bottom > bounds.bottom) container.scrollTop += item.bottom - bounds.bottom + 8;
    else if (item.top < bounds.top) container.scrollTop -= bounds.top - item.top + 8;
  }, [expanded, p.page]);
  return (
    <nav ref={nav} className="grouped-navigation" aria-label="주 메뉴">
      {navigationGroups.map((group) => (
        <div
          className={`nav-group ${current.key === group.key ? 'is-current' : ''}`}
          key={group.key}
        >
          <button
            className="nav-group-toggle"
            aria-expanded={expanded === group.key}
            aria-controls={`nav-${group.key}`}
            onClick={() => setExpanded(expanded === group.key ? null : group.key)}
          >
            <group.icon size={19} aria-hidden="true" />
            <span>{group.name}</span>
            {group.key === 'respond' && p.firing > 0 && (
              <b className="nav-alert-count" aria-label={`발생 중인 알림 ${p.firing}개`}>
                {p.firing}
              </b>
            )}
            <ChevronDown size={15} className="nav-disclosure" aria-hidden="true" />
          </button>
          <div id={`nav-${group.key}`} hidden={expanded !== group.key} className="nav-group-pages">
            <p>{group.description}</p>
            {group.items.map((item) => (
              <a
                key={item.key}
                href={navigationHref(p.url, item.key)}
                onClick={(event) => go(event, item.key, p.navigate)}
                aria-current={
                  (p.page === 'relations' ? 'overview' : p.page) === item.key ? 'page' : undefined
                }
              >
                <item.icon size={16} aria-hidden="true" />
                <span>{item.name}</span>
              </a>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
export function SectionNavigation(p: NavigationProps) {
  const group = navigationGroup(p.page);
  return (
    <nav className="section-navigation" aria-label={`${group.name} 하위 메뉴`}>
      {group.items.map((item) => (
        <a
          key={item.key}
          href={navigationHref(p.url, item.key)}
          onClick={(event) => go(event, item.key, p.navigate)}
          aria-current={
            (p.page === 'relations' ? 'overview' : p.page) === item.key ? 'page' : undefined
          }
        >
          <item.icon size={16} aria-hidden="true" />
          {item.name}
          {item.key === 'alerts' && p.firing > 0 && (
            <span className="section-alert-count">{p.firing}</span>
          )}
        </a>
      ))}
    </nav>
  );
}
export function MobileNavigation(p: NavigationProps & { openMenu: () => void }) {
  return (
    <nav className="mobile-navigation" aria-label="모바일 바로가기">
      {['overview', 'metrics', 'alerts'].map((key) => {
        const group = navigationGroup(key),
          item = group.items.find((item) => item.key === key)!;
        const active =
          key === 'overview'
            ? navigationGroup(p.page).key === 'investigate'
            : key === 'metrics'
              ? navigationGroup(p.page).key === 'monitor'
              : navigationGroup(p.page).key === 'respond';
        return (
          <a
            key={key}
            href={navigationHref(p.url, key)}
            onClick={(event) => go(event, key, p.navigate)}
            aria-current={p.page === key ? 'page' : active ? 'location' : undefined}
          >
            <span className="mobile-nav-icon">
              <item.icon size={20} aria-hidden="true" />
              {key === 'alerts' && p.firing > 0 && (
                <b aria-label={`발생 중인 알림 ${p.firing}개`}>{p.firing}</b>
              )}
            </span>
            <span>
              {key === 'overview' ? '요청 조사' : key === 'metrics' ? '운영 현황' : '장애 대응'}
            </span>
          </a>
        );
      })}
      <button
        onClick={p.openMenu}
        aria-haspopup="dialog"
        aria-current={
          ['quality', 'manage'].includes(navigationGroup(p.page).key) ? 'location' : undefined
        }
      >
        <Menu size={20} aria-hidden="true" />
        <span>전체 메뉴</span>
      </button>
    </nav>
  );
}
export function NavigationMenu(
  p: NavigationProps & {
    close: () => void;
    search: string;
    setSearch: (value: string) => void;
    services: NavigationService[];
    onService: (service: NavigationService) => void;
  },
) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);
  const matching = navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesNavigation(group, item, p.search)),
    }))
    .filter((group) => group.items.length);
  const serviceMatches = p.services.filter((service) =>
    `${service.name} ${service.environment}`
      .toLocaleLowerCase()
      .includes(p.search.trim().toLocaleLowerCase()),
  );
  const services = serviceMatches.slice(0, 8);
  function navigate(page: string) {
    p.close();
    p.navigate(page);
  }
  return (
    <Dialog title="전체 메뉴 · 빠른 이동" onClose={p.close}>
      <div className="navigation-menu">
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <input
            ref={input}
            autoFocus
            aria-label="메뉴 및 서비스 검색"
            placeholder="메뉴·서비스 검색 (예: 외부 API, 유지보수)"
            value={p.search}
            onChange={(event) => p.setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (matching[0]?.items[0] || services[0])) {
                event.preventDefault();
                if (matching[0]?.items[0]) navigate(matching[0].items[0].key);
                else {
                  p.close();
                  p.onService(services[0]);
                }
              }
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <p className="navigation-menu-hint">
          화면을 옮겨도 워크스페이스·리전·서비스·조사 시간은 유지됩니다.
        </p>
        {p.search.trim() && (
          <p className="navigation-search-status" role="status">
            메뉴 {matching.reduce((count, group) => count + group.items.length, 0)}개 · 서비스{' '}
            {serviceMatches.length}개
            {(matching.length > 0 || services.length > 0) && ' · Enter로 첫 결과 이동'}
          </p>
        )}
        <div className="navigation-menu-groups">
          {matching.map((group) => (
            <section key={group.key} aria-label={group.name}>
              <h3>
                <group.icon size={17} aria-hidden="true" />
                {group.name}
              </h3>
              {group.items.map((item) => (
                <a
                  key={item.key}
                  href={navigationHref(p.url, item.key)}
                  onClick={(event) => go(event, item.key, navigate)}
                  aria-current={
                    (p.page === 'relations' ? 'overview' : p.page) === item.key ? 'page' : undefined
                  }
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              ))}
            </section>
          ))}
        </div>
        {services.length > 0 && (
          <section className="navigation-service-results" aria-label="인벤토리 서비스">
            <h3>
              <Boxes size={17} aria-hidden="true" />
              인벤토리 서비스
            </h3>
            {serviceMatches.length > services.length && (
              <p className="navigation-menu-hint">
                {serviceMatches.length}개 중 {services.length}개 표시 · 이름으로 검색해 좁혀보세요.
              </p>
            )}
            <div>
              {services.map((service) => (
                <button
                  key={JSON.stringify([service.name, service.environment])}
                  onClick={() => {
                    p.close();
                    p.onService(service);
                  }}
                >
                  <strong>{service.name}</strong>
                  <span>{service.environment}</span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        )}
        {!matching.length && !services.length && (
          <div className="navigation-no-results">
            <strong>일치하는 메뉴나 서비스가 없습니다.</strong>
            <p>화면 이름이나 서비스 이름으로 다시 검색하세요.</p>
            <button className="text-button" onClick={() => p.setSearch('')}>
              전체 메뉴 보기
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
