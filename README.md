# SeatSAC-gitops

SeatSAC staging 배포 상태를 담는 레포다. ArgoCD가 이 레포의 `main`을 클러스터(`cinema-staging-eks`)에 그대로 맞춘다.
**이 레포의 main 머지 = 배포.** 앱 코드·Terraform은 `SeatSAC` 레포, 규칙은 SeatSAC `docs/service-runtime-contract.md`가 기준이다.

- **Public 레포다** (GitHub 무료 플랜은 Private 레포에 ruleset을 적용하지 않는다, SeatSAC ADR-74). 그래서 **계정 ID·AWS 엔드포인트·레지스트리 주소·키를 두지 않는다** → 아래 "값은 어디서 오나". `gitops-validate`가 막는다
- ArgoCD는 이 레포를 HTTPS로 읽는다(자격 증명 없음)
- main ruleset: 사람은 PR만. 우회 목록에 **GitHub App `seatsac-build-push`**(SeatSAC `build-push`의 태그 커밋) — SeatSAC 런북 6-A-3. 조직 정책상 Deploy key는 쓰지 않는다
- Secret 매니페스트를 두지 않는다 — `{svc}-secrets`·`{svc}-migrator-secrets`는 SeatSAC Terraform(`envs/staging-k8s`)이 만든다. CI가 막는다
- 클러스터를 `kubectl apply/edit`로 직접 고치지 않는다 (selfHeal이 되돌린다)

## 구조

```
.
├── apps/                          ArgoCD Application (App of Apps)
│   ├── root.yaml                  루트 — ArgoCD 설치 직후 한 번만 적용
│   └── staging/                   project · 플랫폼 2 · cinema-common (서비스 Application 5개는 SeatSAC Terraform)
├── platform/                      Helm 차트 values (차트 자체는 apps/staging에서 버전 고정)
│   ├── argo-rollouts/
│   └── kube-prometheus-stack/
├── base/                          서비스별 공통 매니페스트 (값 없음)
│   ├── common/                    앱 namespace 인바운드 기본 거부 + analysis
│   ├── gateway/  booking/         Rollout(블루/그린) · Service · preview Service · NetworkPolicy · PodMonitor
│   ├── catalog/  user/  payment/  Deployment(롤링) · Service · NetworkPolicy · PodMonitor
│   └── {catalog,booking,user,payment}/flyway-job.yaml   DB 마이그레이션 훅 Job (gateway는 DB 없음)
├── overlays/staging/{svc}/        staging 값: ConfigMap {svc}-config (엔드포인트는 ${키}만)
│   └── image-tag/                 이미지 태그(newTag)만 — build-push가 커밋
├── components/rollout/            kustomize가 Rollout 안의 ConfigMap 해시 이름을 바꾸게 하는 설정
├── analysis/                      블루/그린 AnalysisTemplate (booking · gateway)
└── .github/                       CODEOWNERS · PR 템플릿 · gitops-validate
```

| 서비스 | 배포 | replicas / HPA | requests cpu·mem / limit mem | 인바운드 허용 |
| --- | --- | --- | --- | --- |
| gateway | Rollout 블루/그린 | 1 / 없음 | 250m·512Mi / 768Mi | ALB(VPC CIDR) |
| booking | Rollout 블루/그린 | 1 / 1~4 | 250m·512Mi / 768Mi | gateway·catalog·user |
| catalog | Deployment 롤링 | 1 / 1~4 | 200m·448Mi / 640Mi | gateway·booking·user |
| user | Deployment 롤링 | 1 / 1~2 | 150m·384Mi / 576Mi | gateway |
| payment | Deployment 롤링 | 1 / 없음 | 150m·384Mi / 576Mi | booking |

모든 서비스: monitoring namespace → 8080 허용, egress 제한 없음.

## sync 순서

```
wave -10  argo-rollouts · kube-prometheus-stack (CRD)
wave  -5  cinema-common (기본 거부 NetworkPolicy · AnalysisTemplate)
wave   0  cinema-{svc} 앱마다 (Application은 SeatSAC Terraform envs/staging-k8s/argocd_apps.tf):
            ConfigMap {svc}-config (wave -2) → Flyway Job (Sync 훅, wave -1) → Rollout/Deployment (wave 0)
```

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
| 차트 `targetRevision` | `CHANGE_ME` | `helm search repo` 결과로 고정 (비밀 아님, 이 레포에 커밋) | 3.1.6 · 3.1.7 |

- 새 엔드포인트가 필요하면 SeatSAC `docs/service-runtime-contract.md` 3장 표와 `infra_endpoints.tf`에 먼저 키를 추가하고, 여기에는 `${키}`만 쓴다
- 로그·PR에 이미지 주소를 붙일 때 계정 ID는 `<ACCOUNT_ID>`로 가린다

## 열린 항목

- 블루/그린 분석은 preview 파드로 들어오는 요청이 있어야 의미가 있다. 요청이 0이면 0%로 통과한다. 분석 중 preview로 트래픽을 보내는 방법은 3.1.6에서 정한다
- ArgoCD 설치 방법은 3.1.5 (SeatSAC 런북). 서비스 Application은 ArgoCD 설치·root sync 뒤 Terraform `argocd_apps_enabled = true`로 만든다(SeatSAC 런북 6-C)

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
