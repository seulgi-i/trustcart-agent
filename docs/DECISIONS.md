# TrustCart — 결정 기록

작성: 2026-11-04 KST  
상태: **설계 검토 중. 제안 채택과 사용자 확정을 구분한다.**

## 기록 규칙

- CONFIRMED: 사용자가 명시한 작업 조건 또는 실제 확인된 사실.
- PROPOSED: 리드가 근거를 비교해 추천한 설계. 아직 사용자 미확정.
- ACCEPTED / REJECTED: 이후 사용자의 답을 받은 설계 결정.
- 실행자는 DESIGN.md와 이 문서를 먼저 읽는다. 미확정 결정을 승인된 사실로 바꾸지 않는다.
- 변경 때 날짜, 질문, 답, 이유, 영향 파일을 남긴다. 과거 결정을 덮어쓰지 않는다.

## 이미 확인된 것

| ID | 상태 | 내용 | 근거 |
|---|---|---|---|
| C-001 | CONFIRMED | 지금은 설계 검토만 한다. 애플리케이션 코드를 더 작성하지 않는다 | 사용자의 마지막 요청 |
| C-002 | CONFIRMED | 7일 솔로 개발, 마지막 날 배포·영상·제출. 범위를 넘는 기능은 P1 | 사용자 요청 |
| C-003 | CONFIRMED | 단계 1–6 뒤 지정 보안 감사, 단계 4/5 뒤 graphify, 결과 누적 | 사용자 요청. 아직 실행하지 않음 |
| C-004 | CONFIRMED | 공개 OSS repo·라이선스, 실제 PayPal sandbox+AI, 작동 데모, 공개 YouTube 3분 미만, 영어/번역 | [공식 규칙](https://paypalaihackathon.devpost.com/rules) |
| C-005 | CONFIRMED | 앞선 생성 파일은 미완성. npm 설치 프로세스 종료, node_modules/lockfile 미존재 확인. 성공 빌드·테스트 증거 없음 | 이번 턴 읽기 전용 확인 |
| C-006 | CONFIRMED | DESIGN.md는 초안으로 저장하고, grill 질문의 답을 받으며 최종화 | 사용자 요청 |

## 검토자와 통합 결과

아키텍트·보안·PayPal·심사위원은 각각 별도 작업자로 검토했다. 작업자 수 제한 때문에 아키텍트 검토 종료 후 같은 작업자에게 UX만을 보는 별도 과제를 배정했다. UX 결과는 아키텍처 결론과 구분해 수집했다. 다섯 명의 서로 다른 인간 전문가 또는 다섯 개의 완전히 격리된 모델이 검증했다고 주장하지 않는다.

| 관점 | 핵심 제안 | 리드 처리 |
|---|---|---|
| 아키텍트 | 단일 모놀리스, 불변 snapshots, 결정적 gate, capture MVP, SQLite 배포 조건 확인 | 기본안에 반영 |
| 보안 | 스캐너보다 권한 분리, 사용자 확인, labels 비공개, TOCTOU/소유권/재시도 방어 | P0 계약으로 반영 |
| PayPal | 직접 REST, 실제 sandbox 첫날 확인, authorize/void는 별도 엔드포인트, 검증 webhook | REST·조기 검증·webhook 반영. 지연 capture는 P1 |
| 심사위원 | 공격 한 번 차단 + 정상 결제 한 번 완주, 팀 비품 이야기, 2:50 영상 | 이야기와 scope 축소 반영, 대상 사용자 미확정 |
| UX | intent 확인은 새 작업/권한 변경 때만, DENY에 승인 버튼 금지, 기술 용어보다 변경 이유 | 기본 UI 계약에 반영 |

## 제안 결정과 이견 해결

### D-001 — CAPTURE 중심, 자동 지연 결제 제외

상태: PROPOSED, Q1 대기.

- 선택: P0는 CAPTURE intent로 실제 결제 완료. 자동 countdown, 브라우저 알림, refund 제외.
- 다른 의견: PayPal 관점에서는 AUTHORIZE→수동 capture/void도 구현 가능하며 이야기와 맞는다. 심사 관점에서는 추가 상태 복구보다 완결된 정상 결제를 우선한다.
- 선택 이유: 결제 초보·7일·필수 PayPal 통합이라는 제약에서 즉시 capture가 실패 지점이 적다. 자동 capture를 제거하면 영속 스케줄러와 cancel/capture 경쟁의 필수 범위를 줄인다.
- 보존: P0가 안정적일 때 수동 AUTHORIZE/VOID 한 흐름만 P1로 선택 가능. 기존 CAPTURE 주문을 뒤늦게 AUTHORIZE로 변경하지 않는다.

### D-002 — 자체 mandate 모델, AP2 준수 주장 제외

상태: PROPOSED.

- 선택: 사용자 확인 Intent와 승인된 cart snapshot을 핵심으로 삼고 Ed25519는 P1.
- 의견 비교: 아키텍트와 보안은 서명보다 확인 절차가 우선이라고 일치했다. 초기 기획은 서명을 핵심으로 두었으므로 사용자에게 우선순위 변경을 확인해야 한다.
- 이유: 서버 서명은 사용자 개인키 동의가 아니다. 현재 AP2는 Checkout/Payment Mandate를 정의하므로 과거 개념을 그대로 준수했다고 소개할 수 없다.
- 근거: [AP2 v0.2](https://ap2-protocol.org/ap2/specification/).
- 영향: 발표에는 AP2-inspired라고 표시. 핵심 의미적 이해 정확성을 암호학으로 보장한다고 표현하지 않음.

### D-003 — 점수 대신 규칙 사유

상태: PROPOSED.

- 선택: DENY > NEEDS_APPROVAL > ALLOW. 개별 reason을 표시.
- 이유: 수량 위반이 좋은 판매자 점수로 상쇄되어서는 안 된다. 점수 튜닝·설명 비용을 줄인다.
- 사용자 승인으로 hard DENY를 풀지 않는다. 변경된 의도를 다시 확인한다.
- 의미적 취향 적합성은 별도 인간 검토 사유이고 완전 자동 검증이 아니다.

### D-004 — 일회용 토큰은 내부 DB Grant

상태: PROPOSED.

- 선택: orderId에 고유한 BudgetGrant. 브라우저/LLM용 JWT 없음.
- 이유: 실제 권한 집행 지점은 단일 서버다. 서명된 토큰 발급 생태계를 추가할 필요가 없다.
- 제약: 예약·작업 생성·상태 변경을 로컬 transaction으로 수행. timeout 뒤 grant 재발급 금지.
- 일일 한도는 P1이며 예약 원장을 구현하기 전 UI에서 제공하지 않음.

### D-005 — runtime 권한 분리가 스캐너보다 우선

상태: PROPOSED.

- 선택: AI는 searchProducts/buildCart만. approve/capture/updatePolicy/issueGrant는 노출하지 않음.
- 이유: untrusted 태그와 동일 턴 금지는 다음 턴 영향이나 의미적 우회를 막는 충분조건이 아니다.
- isMalicious는 fixture 정답이다. 차단 조건에 사용하지 않음.
- 기존 초안의 isMalicious 기반 격리는 이 설계에 맞게 교체해야 함. 이번에는 코드를 수정하거나 보안 감사를 했다고 주장하지 않음.
- 근거: [Invariant 문서](https://raw.githubusercontent.com/invariantlabs-ai/docs/main/docs/mcp-scan/guardrails-reference.md).

### D-006 — SQLite 유지 시 유료 Render

상태: PROPOSED, 비용 동의 대기.

- 선택: 단일 Render 서비스+영속 디스크, 단일 SQLite DB.
- 대안: Vercel 선호 시 관리형 Postgres 등 영속 외부 DB로 변경.
- 이유: Vercel 로컬 파일을 DB로 쓰는 설계는 배포에서 영속성을 제공하지 않는다. Render 디스크는 유료 서비스에 연결할 수 있다.
- 근거: [Vercel](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel), [Render](https://render.com/docs/disks).
- 주의: Render 별도 cron/worker와 앱의 SQLite 디스크 공유를 가정하지 않는다. P0에는 자동 capture worker 없음.

### D-007 — toolkit 대신 최소 REST Provider

상태: PROPOSED.

- 선택: 서버 전용 직접 REST 구현.
- 이유: 검토한 toolkit capture는 Orders capture이며 AUTHORIZE용 Payments capture/void 전체를 대체하지 못한다. LLM에 결제 도구를 주는 것도 핵심 경계와 맞지 않는다.
- 근거: [실제 TypeScript 함수](https://github.com/paypal/agent-toolkit/blob/main/typescript/src/shared/functions.ts).
- P0에 사용하는 메서드만 구현하고 P1 메서드는 미리 만들지 않음.

### D-008 — 최소 verified webhook과 대사 포함

상태: PROPOSED.

- 의견 비교: 한 번의 동기식 시연에는 웹훅 없이도 가능하지만 PayPal 리뷰는 신뢰를 주장하는 서비스의 복구 경로를 권고.
- 선택: 최소 웹훅 검증·중복 제거·현재 resource 조회와 사용자 상태 재조회 포함.
- 이유: 자동 지연 capture를 포기해 확보한 시간을 결과 불명과 이중 실행 방어에 사용한다.
- 범용 큐·이벤트 버스·여러 event subscriber는 만들지 않음.
- 근거: [PayPal 웹훅](https://developer.paypal.com/api/rest/webhooks/rest/).

### D-009 — 승인 UX의 중복 최소화

상태: PROPOSED.

- 의견 차이: 아키텍트의 확인 단계가 매 대화마다 반복될 수 있다는 UX 우려.
- 선택: 새 구매 작업 또는 권한 범위 변경 때만 Intent 확인. 설명 질문은 확인 생략. 마지막 cart 확인과 PayPal 구매자 승인은 유지.
- hard deny에는 재구성/조건 수정만 제공. soft threshold만 승인함에서 검토.
- ALLOW를 무인 결제로 오해하지 않게 표시.

### D-010 — 팀 비품 이야기와 영어 우선

상태: PROPOSED, 대상 사용자 선택 대기.

- 선택: 영상은 작은 팀의 생활용품 구매로 한정, 상품 카탈로그의 캠핑 항목은 유지.
- 이유: 승인 threshold·seller 제한의 필요성이 자연스럽다는 심사 관점. 새 도메인·상품 크롤링은 추가하지 않음.
- 영어 제출 요건 때문에 영어 한 언어 완성 후 한국어는 P1.
- 해커톤 수상 가능성에 관한 조언은 전략적 추론이지 사실이 아님.

### D-011 — 로그를 변조 불가능하다고 표현하지 않음

상태: PROPOSED.

- 선택: P0는 상태 전이와 함께 저장되는 타임라인. P1은 hash chain 검증/export.
- 이유: 전체 DB와 서명키를 가진 관리자에게 단순 chain은 방어가 안 됨. 외부 checkpoint는 범위 밖.
- 실제 제공하는 증거 수준만 문서화한다.

## 도구와 스킬 확인

- context-mode: 사용 가능, 이번 리서치/출력 관리에 사용.
- andrej-karpathy-skills: 로컬 설치는 못 찾았으나 [공개 가이드라인](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)을 읽고 적용. 가정 명시, 최소 구현, 필요한 변경만, 검증 목표를 적용.
- grill-me: [현재 wrapper](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md)는 grilling을 호출한다. [grilling 원문](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)은 독립 질문 묶음을 제안하지만, **사용자의 한 번에 한 질문 지시를 우선**한다.
- Cloudflare security-audit: [공개 원문](https://github.com/cloudflare/security-audit-skill/blob/main/skills/security-audit/SKILL.md)을 리서치했다. 로컬 설치·실행·격리 환경 준비는 하지 않았고 코드 감사도 아직 안 했다.
- graphify: [공식 후보 저장소](https://github.com/Graphify-Labs/graphify)를 확인. 설치·실행 안 함. 사용자가 다른 graphify를 뜻하면 출처 확정 필요.
- 설치를 위해 사용자 설정·네트워크 권한을 바꾸지 않았음.

## Grill 진행

현재: Q1만 질문할 예정. 나머지 질문 후보는 DESIGN.md 마지막에 있다.

Q1: 기본 제출 범위를 “사람이 최종 확인하는 AI 구매 + 실제 PayPal capture”로 고정하고 자동 지연 결제·환불·AP2 준수는 이번 제출에서 빼는가?

추천: 예. 승인 경계·정상 결제·공격 차단에 집중하고, P0 완료 후 단 하나의 P1만 고른다.

사용자 답: 아직 없음.  
최종 설계 확정: 아직 아님.

