# SeatSAC-gitops

SeatSAC staging 배포 상태를 담는 레포다. ArgoCD가 이 레포의 `main`을 클러스터(`cinema-staging-eks`)에 그대로 맞춘다.
**이 레포의 main 머지 = 배포.** 앱 코드·Terraform은 `SeatSAC` 레포, 규칙은 SeatSAC `docs/service-runtime-contract.md`가 기준이다.

- **Public 레포다** (GitHub 무료 플랜은 Private 레포에 ruleset을 적용하지 않는다, SeatSAC ADR-74). 그래서 **계정 ID·AWS 엔드포인트·레지스트리 주소·키를 두지 않는다** → 아래 "값은 어디서 오나". `gitops-validate`가 막는다
- ArgoCD는 이 레포를 HTTPS로 읽는다(자격 증명 없음). ArgoCD 설치·root 앱·서비스 Application은 SeatSAC Terraform `envs/staging-k8s`(3.1.5)
- main ruleset: 사람은 PR만. 우회 목록에 **GitHub App `seatsac-build-push`**(SeatSAC `build-push`의 태그 커밋) — SeatSAC 런북 6-A-3. 조직 정책상 Deploy key는 쓰지 않는다
- Secret 매니페스트를 두지 않는다 — `{svc}-secrets`·`{svc}-migrator-secrets`는 SeatSAC Terraform(`envs/staging-k8s`)이 만든다. CI가 막는다
- 클러스터를 `kubectl apply/edit`로 직접 고치지 않는다 (selfHeal이 되돌린다)

## 구조

```
.
├── apps/                          ArgoCD Application (App of Apps)
│   └── staging/                   project · 플랫폼 2 · cinema-common
│                                  (root 앱 cinema-root·서비스 Application 5개는 SeatSAC Terraform argocd_apps.tf)
├── platform/                      Helm 차트 values (차트 자체는 apps/staging에서 버전 고정)
│   ├── argo-rollouts/
│   └── kube-prometheus-stack/
├── base/                          서비스별 공통 매니페스트 (값 없음)
│   ├── common/                    앱 namespace 인바운드 기본 거부 + analysis
│   ├── gateway/  booking/         Rollout(블루/그린) · Service · preview Service · NetworkPolicy · PodMonitor (gateway는 + Ingress → ALB)
│   ├── catalog/  user/  payment/  Deployment(롤링) · Service · NetworkPolicy · PodMonitor
│   └── {catalog,booking,user,payment}/flyway-job.yaml   DB 마이그레이션 훅 Job (gateway는 DB 없음)
├── overlays/staging/{svc}/        staging 값: ConfigMap {svc}-config (엔드포인트는 ${키}만)
│   └── image-tag/                 이미지 태그(newTag)만 — build-push가 커밋
├── components/rollout/            kustomize가 Rollout 안의 ConfigMap 해시 이름을 바꾸게 하는 설정
├── analysis/                      블루/그린 AnalysisTemplate (booking · gateway) + smoke/ 분석 트래픽 k6 스크립트
└── .github/                       CODEOWNERS · PR 템플릿 · gitops-validate
```

| 서비스 | 배포 | replicas / HPA | requests cpu·mem / limit mem | 인바운드 허용 |
| --- | --- | --- | --- | --- |
| gateway | Rollout 블루/그린 | 1 / 없음 | 250m·512Mi / 768Mi | ALB(VPC CIDR) · 분석 Job |
| booking | Rollout 블루/그린 | 1 / 1~4 | 250m·512Mi / 768Mi | gateway·catalog·user · 분석 Job |
| catalog | Deployment 롤링 | 1 / 1~4 | 200m·448Mi / 640Mi | gateway·booking·user |
| user | Deployment 롤링 | 1 / 1~2 | 150m·384Mi / 576Mi | gateway |
| payment | Deployment 롤링 | 1 / 없음 | 150m·384Mi / 576Mi | booking |

모든 서비스: monitoring namespace → 8080 허용, egress 제한 없음.

## sync 순서

```
Terraform (SeatSAC envs/staging-k8s, 한 번의 apply)
  ArgoCD(helm) → argocd-apps(helm): cinema-root + cinema-{svc}

cinema-root (apps/staging) — 앞 wave 앱이 Healthy가 된 뒤 다음 wave (Application health 계산 켬)
  wave -20  AppProject cinema
  wave -10  argo-rollouts · kube-prometheus-stack (Rollout·PodMonitor CRD)
  wave  -5  cinema-common (기본 거부 NetworkPolicy · AnalysisTemplate)

cinema-{svc} (root 밖, 동시에 시작 — CRD가 아직 없으면 재시도 10회·최대 약 20분으로 맞춘다)
  ConfigMap {svc}-config (wave -2) → Flyway Job (Sync 훅, wave -1) → Rollout/Deployment·Ingress (wave 0)
```

| 앱 | 차트·경로 | 버전 |
| --- | --- | --- |
| argo-rollouts | argo-helm `argo-rollouts` | `2.43.8` |
| kube-prometheus-stack | prometheus-community `kube-prometheus-stack` | `92.13.1` |
| ArgoCD 자체 | SeatSAC `staging-k8s.tfvars` `argocd_chart_version` | Terraform |

## 상태 보기

```bash
kubectl -n argocd get applications                      # 팀원도 가능 (cinema-dev)
kubectl -n argocd port-forward svc/argocd-server 8080:80   # http://localhost:8080 — 로그인 없이 읽기 전용
```

sync·재시작 같은 조작은 관리자만(admin). 막히면 이 레포에 PR로 고치는 것이 원칙이다

## 배포 흐름

1. SeatSAC main 머지 → `build-push`가 이미지 `cinema/{svc}:{sha7}`을 ECR에 올리고
2. 이 레포 `overlays/staging/{svc}/image-tag/kustomization.yaml`의 `newTag`**만** yq로 바꿔 main에 직접 커밋 (`deploy(staging): {svc} → {sha7}`, GitHub App `seatsac-build-push` 토큰, 커밋 작성자 `seatsac-build-push[bot]`). booking·gateway가 같이 바뀌면 booking만
3. ArgoCD가 sync(Application의 `kustomize.images`가 `cinema/{svc}` 앞에 ECR 레지스트리를 붙임) → Flyway → 롤링 또는 블루/그린(분석 통과 시 전환)

- **롤백**: 직전 태그 커밋을 revert하는 PR
- **설정 변경**: overlay ConfigMap을 PR로 수정. ConfigMap 이름에 해시가 붙어 파드가 자동으로 다시 뜬다
- 블루/그린 서비스(gateway·booking)는 동시에 배포하지 않는다 (노드 2대)

## 값은 어디서 오나 (이 레포에 없는 것)

| 값 | 이 레포에는 | 실제 값 | 붙는 곳 |
| --- | --- | --- | --- |
| ECR 레지스트리(계정 ID) | 이미지 이름 `cinema/{svc}`만 | SeatSAC Terraform `envs/staging-k8s/argocd_apps.tf` | 서비스 Application `spec.source.kustomize.images` |
| 이미지 태그 | `overlays/staging/{svc}/image-tag` `newTag` | SeatSAC `build-push` (처음엔 `CHANGE_ME`) | 이 레포 |
| RDS·Valkey 주소 | `${DB_HOST}` · `${VALKEY_HOST}` | ConfigMap `cinema-infra-endpoints` (Terraform `envs/staging-k8s/infra_endpoints.tf`) | 파드 envFrom → Spring이 기동 때 치환. Flyway Job은 `$(DB_HOST)` |
| SQS 큐 URL | `${SQS_NOTIFICATION_URL}` | 위와 같음 | booking |
| Cognito issuer·client ID | `${COGNITO_ISSUER_URI}` · `${COGNITO_CLIENT_ID}` | 위와 같음 (Cognito 전에는 빈 값) | gateway |
| DB 비밀번호 | Secret 이름만 | `{svc}-secrets`·`{svc}-migrator-secrets` (Terraform) | envFrom |
| 차트 `targetRevision` | 정확한 버전 (위 표) | `helm search repo`로 확인해 PR (비밀 아님) | 이 레포 |

- 새 엔드포인트가 필요하면 SeatSAC `docs/service-runtime-contract.md` 3장 표와 `infra_endpoints.tf`에 먼저 키를 추가하고, 여기에는 `${키}`만 쓴다
- 로그·PR에 이미지 주소를 붙일 때 계정 ID는 `<ACCOUNT_ID>`로 가린다

## 블루/그린 분석 (3.1.6)

booking·gateway는 새 버전을 preview로 띄운 뒤 `analysis/{svc}-prepromotion`이 통과해야 active로 전환한다(`autoPromotionEnabled: true`).

| 지표 | 조건 (preview 파드, `initialDelay` 2분 뒤 1분 × 3회 ≈ 5분) | 대상 |
| --- | --- | --- |
| `preview-traffic` | 분석 트래픽 Job(k6 `grafana/k6:1.7.1`, 4분 30초)이 끝까지 돌고 조회 응답 200이 95% 이상 (404 같은 5xx 아닌 고장도 잡음) | 둘 다 |
| `preview-requests` | actuator 제외 요청 **≥ 20건/분** — 트래픽이 안 들어갔으면 통과가 아니라 실패(첫 측정 1회는 봐줌, `failureLimit: 1`) | 둘 다 |
| `http-5xx-ratio` | actuator 제외 5xx **≤ 1%** | 둘 다 |
| `payment-failure-ratio` | `booking_payment_call_total` timeout·error **≤ 5%** (declined 제외) | booking |

- **트래픽**: 실제 사용자 트래픽은 active로만 가서 preview에는 요청이 없다(probe만). 그래서 분석 Job이 `{svc}-preview:8080`으로 **데이터를 바꾸지 않는 조회**를 직접 보낸다(스크립트 `analysis/smoke/`, ConfigMap `rollout-smoke-scripts`). Job 파드 라벨 `app.kubernetes.io/name: rollout-smoke` → NetworkPolicy가 booking·gateway 접근을 허용
  - booking: `GET /screenings/{id}/seats`(catalog·Valkey·RDS — **시드에 있는 실제 회차** `SMOKE_SCREENING_ID`) · `GET /internal/screenings/seat-counts`(RDS). 결제 경로(선점→결제→취소)는 BKG-10(SeatSAC #37) 머지 후 추가 → 그때 결제 호출 최소 건수도 건다
  - gateway: `GET /api/movies` · `GET /api/theaters`(→ catalog). 토큰은 쓰지 않는다
- **실패하면**: AnalysisRun Failed → Rollout **abort** → active는 이전 버전 그대로(트래픽 전환 없음 = 자동 롤백), preview는 30초 뒤 축소. preview가 10분 안에 Ready가 안 돼도 abort(`progressDeadlineAbort`). gitops 태그는 새 버전에 남아 있으므로 **태그 커밋 revert PR**로 맞춘다
- **파드 수**: 분석 중 preview는 1개(`previewReplicaCount: 1`), 전환 직전 active 수까지 늘린 뒤 전환 → 전환 순간~60초만 2배. 노드 2대라 booking HPA가 최대(4)일 때 배포하면 preview가 Pending될 수 있다(그러면 10분 뒤 abort)
- **상태 보기**: `kubectl argo rollouts get rollout booking -n cinema-staging --watch` (플러그인), `kubectl -n cinema-staging get analysisrun`

## 열린 항목

- gateway Application은 Cognito(3.3.x) 적용 후 Terraform `cognito_enabled = true`로 생긴다(SeatSAC 런북 6-C). 그 전에는 ALB·CloudFront `/api`가 없다

## 로컬 확인

```bash
kustomize build overlays/staging/booking | less
```

```bash
# ArgoCD가 하는 것처럼 레지스트리까지 붙여 보기 (임시 복사본에서, 결과를 커밋·붙여 넣지 않는다)
# overlays/staging/ 아래 같은 깊이에 임시 사본 → base·Component 상대 경로가 그대로 맞는다. 끝나면 지운다(커밋하지 않는다)
cp -r overlays/staging/booking overlays/staging/_sim-booking
(cd overlays/staging/_sim-booking && kustomize edit set image cinema/booking=example.invalid/cinema/booking && kustomize build . | grep image:)
rm -rf overlays/staging/_sim-booking
```

PR이 올라오면 `gitops-validate`가 모든 kustomization에 대해 `kustomize build`와 kubeconform 검사를 돌리고, 모든 파일(이 README 포함)에 Secret 매니페스트·12자리 숫자(계정 ID)·AWS 서비스 도메인 주소·`newName`이 있으면 실패한다. gitleaks도 같이 돈다.
