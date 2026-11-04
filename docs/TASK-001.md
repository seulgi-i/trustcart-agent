# Task 001 — 배포 가능한 뼈대와 PayPal 연결 가능성 검증

상태: **IN PROGRESS — 2026-11-04 사용자가 구현을 승인(C-007). 코드 작성됨, 실행 검증 전.**  
선행 문서: [DESIGN.md](DESIGN.md), [DECISIONS.md](DECISIONS.md). 배포 선택(Q2)·sandbox 접근(Q4)은 아직 미확인이며 해당 단계(7·8)는 BLOCKED.

진행 기록 (2026-11-04): 단계 2·5·6의 코드와 테스트를 작성했다. 작성 세션에서 node/npm 실행 권한이 없어 설치·lockfile·typecheck·테스트는 **미실행**이다. 단계 3·7·8·9는 사용자 계정/환경이 필요해 미실행. 상세는 [SECURITY.md](SECURITY.md) 단계 1 기록.

## 목표

하루 안에 새 환경에서 시작 가능한 최소 앱과 **실제 PayPal sandbox capture 한 건**을 확인한다. Mock 성공으로 PayPal 검증을 대체하지 않는다.

기술: Next.js App Router, TypeScript, Tailwind, Prisma. DB/호스팅은 승인된 결정에 따른다. SQLite 선택 시 유료 Render 단일 서비스+영속 디스크다.

실행 방식은 다음 턴의 사용자 지시를 따른다. 하위 작업자에게 맡기든 직접 구현하든 아래 검증 계약은 동일하다.

## 범위

포함:
- 기존 미완성 파일 목록과 복구 가능한 부분 확인.
- 최소 앱 기동, DB migration/seed, visitor 세션.
- 기존 30개 JSON의 스키마와 10개 정답 라벨 검증.
- mock checkout 구조 및 별도의 제한된 sandbox 정상 결제 스파이크.
- 공개 저장소 준비, MIT, 영어 실행 안내, 초기 배포.
- 단계 1 보안 감사 및 실제 결과 기록.

제외:
- 새 디자인 전체, 정책 편집 UI, 완성형 채팅.
- 서명, 자동 타이머, authorize/void/refund.
- graphify 강제 실행 — 단계 4/5에서 수행. 준비 여부는 확인.
- 무인 capture, 공개 결제 테스트 백도어, 실제 live merchant 사용.

## 변경할 파일의 책임

| 파일/영역 | 조치 |
|---|---|
| package.json / lockfile / tsconfig / Next·Tailwind 설정 | 설치 가능한 버전으로 검증·고정. lockfile 생성. 의도치 않은 업그레이드 금지 |
| app/layout.tsx, app/page.tsx, 최소 CSS | 실제 기동 가능한 화면. 임포트만 있고 파일이 없는 미완성 참조 정리 |
| prisma/schema.prisma, prisma/migrations/*, prisma/seed.ts | 이번 단계 최소 Product·Session 저장, migration 기반 재현 |
| data/products.json | 30개와 필드 검증. 정답 라벨 유지하되 runtime DTO에서는 제외 |
| src/server/session.ts | 서버 발급 데모 세션과 소유권 헬퍼 |
| src/server/payments/paypal.ts | 고정 sandbox host, 서버 secret, create/get/capture에 필요한 얇은 REST 호출 |
| scripts/paypal-smoke.ts 또는 제한된 개발 전용 checkout | 정상 buyer 승인→capture 검증. production 공개 우회 endpoint 금지 |
| tests/catalog.test.ts / tests/session.test.ts / tests/payment-smoke-contract.test.ts | 아래 검증 계약 |
| .env.example | placeholder만. OPENAI_API_KEY 또는 ANTHROPIC_API_KEY, DATABASE_URL, PayPal sandbox client ID/secret 등 |
| README.md / LICENSE | 영어 시작 방법, sandbox 설정, MIT, 현재 제약 |
| docs/SECURITY.md | 감사 도구 버전·대상·실행 결과·조치 기록 |

기존 파일을 삭제하기 전에 새 파일과의 역할 대응을 제시한다. 사용자 파일이나 환경변수 값을 출력하지 않는다. 설치 실패를 해결하기 위해 PowerShell 보안 정책을 바꾸지 않는다. Windows에서는 npm.cmd를 사용할 수 있다.

## 작업 순서와 검증

- [ ] 1. DESIGN/DECISIONS를 읽고 승인된 선택만 추린다. 열린 선택이 구현을 막으면 해당 질문만 한다.
- [ ] 2. git 상태·기존 파일·미완성 참조·실행 환경을 조사한다. 현재 코드를 완성품으로 가정하지 않는다.
- [ ] 3. PayPal Developer Dashboard 접근과 sandbox business seller/personal buyer, app credentials 유무를 확인한다. 자격증명은 환경변수로 직접 입력하도록 안내하며 채팅으로 받지 않는다.
- [ ] 4. 배포/DB 최소 연결과 필요한 의존성만 설치한다. 재현 가능한 lockfile을 남긴다.
- [ ] 5. 아래 catalog/session 테스트를 먼저 작성해 실패 원인을 확인한다. 최소 구현 후 통과시킨다.
- [ ] 6. 서버 REST 어댑터의 금액·currency·merchant 고정 및 같은 request ID 재사용 계약을 테스트한다.
- [ ] 7. 실제 sandbox buyer 승인→capture를 한 번 실행한다. 금액·capture status·capture ID만 증거로 남긴다.
- [ ] 8. 초기 배포에서 앱 기동과 DB 영속성을 확인한다. 저장 데이터가 재시작 뒤 남는지 검사한다.
- [ ] 9. 지정 Cloudflare security-audit으로 단계 1 변경분을 감사한다. 권한·secret·세션·금액·테스트 endpoint 노출을 검토한다.
- [ ] 10. 실제 성공/실패/미검증을 SECURITY.md에 기록한다. 막힌 항목이 있으면 해당 단계 완료로 보고하지 않는다.

## 테스트 계약

| 테스트 이름 | 반드시 입증할 것 |
|---|---|
| catalog_schema_and_labels | 30개 unique ID, 10개 true label, 필수 필드, 0 이상의 정수 stock, 정상적인 USD 소수 정밀도 |
| runtime_catalog_hides_ground_truth | 모델/스캐너/검색 DTO에 isMalicious가 없음. 정답을 보지 않고 실행 |
| money_is_integer_cents | 예: 18.99 USD × 3 = 5697 cents. 부동소수점 누적 합계 금지 |
| session_ownership | 세션 A가 세션 B의 테스트 리소스를 읽거나 수정할 수 없음 |
| paypal_payload_binding | 클라이언트 amount/seller를 무시하고 서버 fixture의 USD 금액과 sandbox merchant 사용 |
| same_operation_same_request_id | 네트워크 재시도 시 새 request ID 생성하지 않음 |
| payment_completion_uses_capture_status | redirect 또는 order APPROVED만으로 PAID가 되지 않음 |
| sandbox_only | live host로 호출되는 설정을 데모 배포에서 거부 |

상위 정책·승인 테스트는 후속 단계 책임이다. 이번 단계에서 통과한 payment smoke가 전체 보안 checkout 완성을 의미하지 않는다.

## 완료 판정

- 새 checkout/clone에서 README대로 설치·DB 초기화·기동이 된다.
- TypeScript 검사와 해당 테스트가 통과한다. 명령, 종료 코드, 실행 시각을 남긴다.
- 실제 PayPal sandbox capture COMPLETED 증거가 있다.
- 배포 환경에서 세션 격리와 DB 영속성을 확인했다.
- repository/client bundle/log에 API secret이 없다.
- 영어 README와 MIT가 존재한다.
- 지정 감사 결과 및 수정 후 재검증을 기록했다.

## 시간 제한과 실패 시 처리

Day 1 종료까지 실제 sandbox 연결이 실패하면 원인과 다음 검증 하나를 기록한다. 전체 UI를 늘려 결제 실패를 가리지 않는다. Day 2까지 해결되지 않으면 P1 전부 동결한다.

MockProvider는 UI 개발용으로만 사용한다. Mock 영상·capture ID를 실제 PayPal 사용으로 표시하지 않는다. 계정 접근 문제는 사용자의 현재 계정 환경에서 확인해야 하며, live 본인확인과 sandbox API 접근을 혼동하지 않는다.

## 보고 형식

변경 파일, 성공한 검증, 실패한 검증, 아직 미검증인 외부 의존성, 단계 감사 결과, 다음 한 작업만 보고한다. “잘 될 것”을 “검증됨”으로 표현하지 않는다.

