import {
  Activity,
  Bell,
  Boxes,
  ChartNoAxesCombined,
  Gauge,
  GitBranch,
  Globe,
  Network,
  Plug,
  ScrollText,
  Server,
  Settings2,
  ShieldAlert,
  Sparkles,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { dimensionKeys, type ResourceSummary } from '../../../packages/contracts/src/index';

export type NavigationService = { name: string; environment: string };

export function navigationServices(
  resources: ResourceSummary[],
  scope: Record<string, string | number | undefined>,
): NavigationService[] {
  const services = new Map<string, NavigationService>();
  for (const resource of resources) {
    if (
      resource.retired ||
      !resource.observedApplication ||
      ['environment', ...dimensionKeys].some(
        (key) => scope[key] && resource[key as keyof ResourceSummary] !== scope[key],
      )
    )
      continue;
    services.set(JSON.stringify([resource.service, resource.environment]), {
      name: resource.service,
      environment: resource.environment,
    });
  }
  return [...services.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.environment.localeCompare(b.environment),
  );
}

export type NavigationPage = {
  key: string;
  name: string;
  icon: LucideIcon;
  description: string;
  keywords: string;
};
export type NavigationGroup = {
  key: string;
  name: string;
  icon: LucideIcon;
  description: string;
  items: NavigationPage[];
};

export const navigationGroups: NavigationGroup[] = [
  {
    key: 'monitor',
    name: '운영 현황',
    icon: Gauge,
    description: '서비스와 각 리전의 현재 상태',
    items: [
      {
        key: 'metrics',
        name: '운영 대시보드',
        icon: Gauge,
        description: '요청량·오류·지연과 주요 운영 이벤트를 확인합니다.',
        keywords: 'dashboard metrics 지표 요약',
      },
      {
        key: 'deployments',
        name: '리전·배포',
        icon: Globe,
        description: '독립 리전의 배포, 모듈과 인스턴스를 비교합니다.',
        keywords: 'region deployment instance 지도 인스턴스 클러스터',
      },
      {
        key: 'services',
        name: '서비스·API',
        icon: Boxes,
        description: '서비스와 API별 요청량, 오류, 응답 지연을 비교합니다.',
        keywords: 'service api endpoint 서버 엔드포인트',
      },
      {
        key: 'hosts',
        name: '인프라',
        icon: Server,
        description: '서버 리소스와 데이터 신선도를 확인합니다.',
        keywords: 'infrastructure host cpu memory 서버 메모리',
      },
    ],
  },
  {
    key: 'investigate',
    name: '요청 조사',
    icon: Network,
    description: '내부 서비스에서 외부 API까지',
    items: [
      {
        key: 'overview',
        name: '요청 흐름',
        icon: Network,
        description: '호출자에서 우리 API와 외부 의존성까지 조사합니다.',
        keywords: 'request flow dependency client server 외부 하위 호출',
      },
      {
        key: 'logs',
        name: '로그',
        icon: ScrollText,
        description: '필요한 로그를 찾고 요청 근거를 연결합니다.',
        keywords: 'log search 검색',
      },
      {
        key: 'traces',
        name: '트레이스',
        icon: GitBranch,
        description: '요청의 스팬에서 지연, 실패와 재시도를 찾습니다.',
        keywords: 'trace span waterfall 워터폴 재시도',
      },
      {
        key: 'analytics',
        name: '오류 분석',
        icon: ChartNoAxesCombined,
        description: '오류 패턴과 관측 요청의 상태를 분석합니다.',
        keywords: 'analytics error 오류 그룹 패턴 분석',
      },
    ],
  },
  {
    key: 'respond',
    name: '장애 대응',
    icon: ShieldAlert,
    description: '감지부터 전달·조사·복구까지',
    items: [
      {
        key: 'alerts',
        name: '알림·규칙',
        icon: Bell,
        description: '알림 규칙, 확인과 전달 이력을 관리합니다.',
        keywords: 'alert rule notification 알림 관리 임계치',
      },
      {
        key: 'incidents',
        name: '장애 관리',
        icon: ShieldAlert,
        description: '담당자와 장애 조사·복구 과정을 기록합니다.',
        keywords: 'incident recovery 타임라인 복구 담당자',
      },
      {
        key: 'policies',
        name: '전달·유지보수',
        icon: Bell,
        description: '담당 팀별 알림 라우팅과 유지보수 시간을 관리합니다.',
        keywords: 'policy routing maintenance 전달 정책 반복 중지',
      },
    ],
  },
  {
    key: 'quality',
    name: '서비스 품질',
    icon: Target,
    description: '오류 예산과 AI 호출 품질',
    items: [
      {
        key: 'slos',
        name: 'SLO·오류 예산',
        icon: Target,
        description: '서비스 수준과 오류 예산 소진율을 평가합니다.',
        keywords: 'slo sli burn rate 서비스 수준 성공률',
      },
      {
        key: 'ai',
        name: 'AI 관측·평가',
        icon: Sparkles,
        description: '모델 호출의 지연, 토큰, 비용과 평가 근거를 봅니다.',
        keywords: 'ai llm model token evaluation 인공지능 워크로드 비용',
      },
    ],
  },
  {
    key: 'manage',
    name: '관리',
    icon: Settings2,
    description: '소유권·연결·수집 플랫폼',
    items: [
      {
        key: 'catalog',
        name: '서비스 카탈로그',
        icon: Boxes,
        description: '서비스 담당 팀과 저장소, 운영 자료를 연결합니다.',
        keywords: 'catalog owner runbook 소유권 팀 문서',
      },
      {
        key: 'connections',
        name: '연결·검사',
        icon: Plug,
        description: '데이터 수집, 알림 채널과 API 검사를 연결합니다.',
        keywords: 'connection settings webhook probe collector 연결 및 설정 합성 검사',
      },
      {
        key: 'platform',
        name: '플랫폼 상태',
        icon: Activity,
        description: '수집·저장·평가·전달 상태를 확인합니다.',
        keywords: 'platform health worker storage queue 작업자 저장소 큐',
      },
    ],
  },
];
export const navigationPages = navigationGroups.flatMap((group) => group.items);
export function navigationGroup(page: string) {
  return (
    navigationGroups.find((group) =>
      group.items.some((item) => item.key === (page === 'relations' ? 'overview' : page)),
    ) ?? navigationGroups[1]
  );
}
export function matchesNavigation(group: NavigationGroup, item: NavigationPage, search: string) {
  const haystack =
    `${group.name} ${item.name} ${item.description} ${item.key} ${item.keywords}`.toLocaleLowerCase();
  return search
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((term) =>
      /^[a-z0-9]+$/.test(term)
        ? (haystack.match(/[a-z0-9]+/g) ?? []).some((word) => word.startsWith(term))
        : haystack.includes(term),
    );
}
export function navigationHref(url: URLSearchParams, page: string) {
  const next = new URLSearchParams(url);
  next.set('page', page === 'relations' ? 'overview' : page);
  for (const key of ['detail', 'detailId', 'search', 'level', 'route', 'edge']) next.delete(key);
  return '?' + next.toString();
}
