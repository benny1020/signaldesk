# Navigation and investigation UX

## Design decision · 2026-10-13

The operator needs to answer three questions quickly: which regional deployment needs attention, which request evidence explains the symptom, and what response is already underway. The old sidebar placed sixteen destinations at the same depth; narrow screens hid their names and required scrolling through icons.

The redesign uses five work areas, one visible child layer and related destinations beside the current page. It preserves the existing investigation-first landing and the full independent-region scope.

| Work area   | Destinations                                 | Operator task                                             |
| ----------- | -------------------------------------------- | --------------------------------------------------------- |
| 운영 현황   | 운영 대시보드, 리전·배포, 서비스·API, 인프라 | Compare regional symptoms and deployment resources        |
| 요청 조사   | 요청 흐름, 로그, 트레이스, 오류 분석         | Follow inbound/internal/external calls and their evidence |
| 장애 대응   | 알림·규칙, 장애 관리, 전달·유지보수          | Detect, acknowledge, investigate, route and recover       |
| 서비스 품질 | SLO·오류 예산, AI 관측·평가                  | Evaluate service objectives and model workload quality    |
| 관리        | 서비스 카탈로그, 연결·검사, 플랫폼 상태      | Establish ownership and inspect telemetry infrastructure  |

### Visual plan

- Ink `#12283f` for the work-area spine; paper `#f3f6fa` for investigation surfaces; white `#ffffff` for content; blue `#2869d8` for current destinations; muted `#566b82` for secondary facts; red `#c84646` only for observed failures.
- Manrope and the existing Korean system fallback remain. Navigation labels and work-area titles are 14px, task descriptions 12px, and page headings retain the existing hierarchy. Resource facts stay compact and aligned.
- Left-aligned layout: sidebar with five disclosure buttons → current work area's children → page breadcrumb and sibling destinations → existing scope-aware investigation content. The active alert count remains visible on its collapsed parent.
- Small screens use named shortcuts and a searchable modal menu instead of a long icon-only rail. The same menu doubles as the desktop command palette. Search matches Korean names, task descriptions and technical terms.

```text
Workspace     Environment / Service / Time
Quick move    Work area / Current page
              [Related page] [Current page] [Related page]
Work areas    Region / module / instance investigation
  Children    Evidence, charts and actions
Account
```

Review against the brief: cosmetic headings alone would leave all sixteen destinations competing for attention. A disclosure layer plus sibling navigation makes the hierarchy actionable. Five nested hover flyouts would hide destinations from keyboard and touch users, so explicit buttons and a searchable modal provide the additional layer. There are no synthetic region links, new deployment assumptions or chart metric changes.

### Interaction contract

Navigation preserves workspace, environment, service, region, module, zone, cluster, namespace, instance, absolute time and timezone. It clears page-specific selection/search fields so a trace dialog or selected edge does not unexpectedly follow an unrelated destination. Existing `page=` URLs remain valid, including the request-flow legacy alias.

The current work area opens after page changes and browser history navigation. Its active child scrolls inside the sidebar, without moving the document. Parent disclosure buttons support Enter/Space and expose their expanded state. Page links retain normal modified-click behavior. The native dialog provides modal focus isolation, restored trigger focus and Escape dismissal; background scrolling is locked while the menu is open. The search field and close button stay available when its contents scroll. `Ctrl/Cmd+K` opens the same quick menu, Enter opens the first result and Tab reaches each link. Selecting a service applies its environment explicitly. Search result counts are announced; Latin prefixes respect word boundaries so AI does not match maintenance. Mobile labels and touch targets remain visible. No operator mutation is performed by navigation.

Service shortcuts derive from the authorized workspace's deployment inventory. They keep environment and deployment dimensions, exclude retired/host-only resources, deduplicate service/environment identities and ignore the current service filter so an operator can switch services directly. The investigation time is retained when opening evidence. Inventory membership does not imply a request occurred in that time window. Up to eight services are previewed; additional matches are explicitly counted and narrowed by search. The existing inventory limit and truncation indicator still apply.

Browser verification and screenshots are recorded in [verification](VERIFICATION.md). This is manual usability/accessibility acceptance, not a full accessibility certification or a real-user study.
