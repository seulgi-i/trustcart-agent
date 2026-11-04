# TrustCart — 보안 검증 기록

상태: **NOT RUN — 설계 검토만 수행. 코드 보안 감사 결과가 아니다.**  
작성: 2026-11-04 KST

## 현재 상태

- 아키텍처 수준 위협 검토는 DESIGN.md에 반영했다.
- Cloudflare security-audit 스킬 원문은 확인했으나 로컬 설치·버전 고정·실행은 하지 않았다.
- graphify는 설치·실행하지 않았다.
- 기존 초안은 빌드·테스트·안전성이 검증되지 않았다.
- 보안 결함 없음, 탐지율 100%, 감사 통과를 주장할 근거가 없다.

## 단계별 필수 게이트

| 단계 | 코드 범위 | 지정 감사 | graphify | 현재 상태 |
|---|---|---|---|---|
| 1 뼈대 | 설정·secret·세션·DB·초기 checkout | Cloudflare security-audit | 준비만 | NOT RUN |
| 2 Mandate | 사용자 확인·snapshot·만료·소유권 | Cloudflare security-audit | — | NOT RUN |
| 3 정책 | 한도·수량·seller·Grant·동시성 | Cloudflare security-audit | — | NOT RUN |
| 4 인젝션 | 비신뢰 텍스트·LLM tool 경계·평가 label | Cloudflare security-audit | 재생성 및 의존 방향 대조 | NOT RUN |
| 5 승인·알림·감사 | 정확한 cart 승인·CSRF·상태·로그 | Cloudflare security-audit | 재생성 및 의존 방향 대조 | NOT RUN |
| 6 PayPal | REST·webhook·멱등성·대사·경쟁 조건 | Cloudflare security-audit | 변경 시 필요성 판단 | NOT RUN |

## 실행 전 준비

1. 사용자가 지정한 출처를 확인하고 프로젝트 범위에 필요한 스킬/CLI를 설치·버전 고정한다.
2. Cloudflare 스킬의 실행 요구를 다시 읽는다. 현재 공개 지침은 코드 실행에 OS 수준 격리, 네트워크 제한, 환경 allowlist, 읽기 전용 대상, scratch 쓰기 및 자원 제한을 요구한다.
3. 이 환경을 만족하지 못하면 안전한 정적 검토와 실행 불가를 구분한다. 지정 full audit을 했다고 대체 표시하지 않는다.
4. 실제 PayPal sandbox 통합 검증은 네트워크 없는 감사 sandbox의 동적 테스트와 별개다. 감사에는 mock provider를, 외부 통합 검증에는 sandbox credentials를 사용하며 결과를 구분한다.
5. 도구가 차단되면 사용자에게 근거와 영향을 보고하고 대체 방식 합의 전에는 필수 게이트 완료로 표시하지 않는다.

근거: [Cloudflare security-audit](https://github.com/cloudflare/security-audit-skill/blob/main/skills/security-audit/SKILL.md), [Graphify](https://github.com/Graphify-Labs/graphify).

## 단계 기록 양식

각 단계 종료 시 아래 내용을 새 항목으로 추가한다.

- 실행 일시 / commit 또는 파일 snapshot / 도구 버전.
- 감사 범위 / 제외 범위 / 실행 환경.
- 확인한 신뢰 경계와 테스트 목록.
- finding ID, 심각도, 영향받는 주체·자원, 파일 위치.
- 재현 근거와 실제/추정 구분.
- 최소 수정 내용과 영향.
- 수정 후 테스트 명령·결과.
- 남은 위험·미검증·차단 사유.
- 단계 판정: PASS / FAIL / BLOCKED. 보고자가 근거 없이 PASS를 쓰지 않는다.

## 단계 1 기록 — 2026-11-04

- 대상: TASK-001 변경분(작업 트리, 커밋 전). 기준 commit 42ff66e.
- 실행 환경: 작성 세션에서 node/npm 명령이 권한 승인 단계에서 차단됨. 의존성 설치·typecheck·테스트·앱 기동을 **실행하지 못했다**.
- Cloudflare security-audit: **NOT RUN** (설치·격리 환경 없음).
- 작성한 경계/테스트(미실행): catalog_schema_and_labels, runtime_catalog_hides_ground_truth, money_is_integer_cents, session_ownership, paypal_payload_binding, same_operation_same_request_id, payment_completion_uses_capture_status, sandbox_only.
- 설계상 조치: Product 테이블·runtime DTO·스캐너에서 isMalicious 제거, 평가 라벨은 src/eval/ground-truth.ts로 분리. 승인 API에 서버 발급 세션과 소유권 필터 적용(타 세션 ID는 404). PayPal host 고정·live 설정 거부·클라이언트 금액/payee 무시·재시도 시 동일 PayPal-Request-Id·capture COMPLETED+금액/통화/payee/reference 일치만 PAID.
- 발견(미수정, 단계 4 대상): 악성 fixture가 `risk-` ID 접두사와 `Fixture Market` seller를 공유해 LLM·스캐너 입력에서 사실상 정답이 노출된다. 평가 무결성에 영향.
- 발견(미수정): /api/chat에 세션·요청 한도 없음. Origin 헤더가 없는 요청은 checkOrigin을 통과(SameSite=Lax 쿠키에 의존).
- 마이그레이션 SQL은 수작업 작성. `prisma migrate dev`로 schema와 drift 없음을 확인해야 한다.
- 단계 판정: **BLOCKED** — 실행 검증·지정 감사·sandbox capture·배포 확인 없음.

## graphify 대조 기준

단계 4/5에서 AST 기반 import/call 근거를 우선한다. 의미적 추론 edge를 확정 의존성으로 취급하지 않는다. 보조 리소스나 secret 파일을 그래프 생성/외부 분석에 포함하지 않는다.

검사할 경계:
- client/UI → server secret/payment infrastructure: 금지.
- agent → capture/approval mutation/policy mutation/grant 발급: 금지.
- domain → Prisma/React/AI SDK/HTTP: 금지.
- payment state mutation을 route별로 중복 구현: 발견 시 단일 service로 이동.
- webhook → 검증 없이 Order 상태 직접 대입: 금지.
- runtime scanner/search → fixture isMalicious: 금지.
- 허용되는 imports는 DESIGN.md의 모듈 방향과 대조.

실제 위반 edge, 원인, 선택한 수정 또는 설계 변경, 재생성 결과를 기록한다. graphify는 런타임 권한 검사를 증명하지 않으므로 테스트를 대체하지 않는다.

## 반드시 재현할 실패 사례

- 악성 상품의 대량 구매/승인 생략 지시가 결제 권한을 얻지 못함.
- 숨은 Unicode 또는 다음 턴 공격을 스캐너가 놓쳐도 서버 조건 위반 거부.
- 정상 설명의 오탐을 측정하며 ground-truth label은 runtime에 없음.
- 중복 product ID 합산 후 수량 제한.
- 승인 이후 cart/가격/통화/정책 변경 시 checkout 차단.
- 다른 방문자의 order/approval/policy 접근 거부.
- 결제 버튼 이중 클릭, timeout 후 재시도, webhook 중복·역순.
- 결과 불명인 주문에 새 payment operation을 만들어 중복 청구하지 않음.
- PAID를 단순 브라우저 callback이나 HTTP 2xx로 판정하지 않음.
- P1 authorize/void 채택 시 capture와 void 동시 요청 중 한쪽만 실행.
- P1 hash chain 채택 시 이벤트 수정 탐지와 전체 체인 재작성 한계를 별도 표시.

