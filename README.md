# SeatSAC-gitops

SeatSAC staging 배포 상태를 담는 레포다. ArgoCD가 이 레포의 `main`을 클러스터(`cinema-staging-eks`)에 그대로 맞춘다.
**이 레포의 main 머지 = 배포.** 앱 코드·Terraform은 `SeatSAC` 레포, 규칙은 SeatSAC `docs/service-runtime-contract.md`가 기준이다.

- Private 유지 (계정 ID·엔드포인트 등 실제 배포 값이 들어 있음)
- Secret 매니페스트를 두지 않는다 — `{svc}-secrets`·`{svc}-migrator-secrets`는 SeatSAC Terraform(`envs/staging-k8s`)이 만든다. CI가 막는다
- 클러스터를 `kubectl apply/edit`로 직접 고치지 않는다 (selfHeal이 되돌린다)

## 구조

```
.
├── apps/                          ArgoCD Application (App of Apps)
│   ├── root.yaml                  루트 — ArgoCD 설치 직후 한 번만 적용
│   └── staging/                   project · 플랫폼 2 · cinema-common · 서비스 5
├── platform/                      Helm 차트 values (차트 자체는 apps/staging에서 버전 고정)
│   ├── argo-rollouts/
│   └── kube-prometheus-stack/
├── base/                          서비스별 공통 매니페스트 (값 없음)
│   ├── common/                    앱 namespace 인바운드 기본 거부 + analysis
│   ├── gateway/  booking/         Rollout(블루/그린) · Service · preview Service · NetworkPolicy · PodMonitor
│   ├── catalog/  user/  payment/  Deployment(롤링) · Service · NetworkPolicy · PodMonitor
│   └── {catalog,booking,user,payment}/flyway-job.yaml   DB 마이그레이션 훅 Job (gateway는 DB 없음)
├── overlays/staging/{svc}/        staging 값: 이미지 태그 · ConfigMap {svc}-config
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
wave   0  cinema-{svc} 앱마다:
            ConfigMap {svc}-config (wave -2) → Flyway Job (Sync 훅, wave -1) → Rollout/Deployment (wave 0)
```

## 배포 흐름

1. SeatSAC main 머지 → `build-push`가 이미지 `cinema/{svc}:{sha7}`을 ECR에 올리고
2. 이 레포 `overlays/staging/{svc}/kustomization.yaml`의 `newTag`를 커밋 (`kustomize edit set image`)
3. ArgoCD가 sync → Flyway → 롤링 또는 블루/그린(분석 통과 시 전환)

- **롤백**: 직전 태그 커밋을 revert하는 PR
- **설정 변경**: overlay ConfigMap을 PR로 수정. ConfigMap 이름에 해시가 붙어 파드가 자동으로 다시 뜬다
- 블루/그린 서비스(gateway·booking)는 동시에 배포하지 않는다 (노드 2대)

## 처음 채울 값 (`CHANGE_ME`)

| 값 | 어디서 | 언제 |
| --- | --- | --- |
| `ACCOUNT_ID` (ECR 주소) | AWS 계정 ID | 3.1.4 |
| `newTag` | build-push가 커밋 | 3.1.4 |
| `CHANGE_ME_RDS_ENDPOINT` · `CHANGE_ME_VALKEY_ENDPOINT` | SeatSAC `envs/staging` output `rds_endpoint` · `valkey_primary_endpoint` | 3.1.5 |
| `APP_SQS_NOTIFICATION_QUEUE_URL` | 3.1.8 output | 3.1.8 |
| `APP_COGNITO_ISSUER_URI` · `APP_COGNITO_CLIENT_ID` | 3.1.11 Cognito output | 3.1.11 |
| 차트 `targetRevision` | `helm search repo` 결과로 고정 | 3.1.6 · 3.1.7 |

## 열린 항목

- 블루/그린 분석은 preview 파드로 들어오는 요청이 있어야 의미가 있다. 요청이 0이면 0%로 통과한다. 분석 중 preview로 트래픽을 보내는 방법은 3.1.6에서 정한다
- ArgoCD 설치 방법과 이 레포를 읽는 Deploy key 등록은 3.1.5 (SeatSAC 런북)
- CI 봇의 이미지 태그 커밋 권한(쓰기 키·ruleset 예외)은 3.1.4

## 로컬 확인

```bash
kustomize build overlays/staging/booking | less
```

PR이 올라오면 `gitops-validate`가 모든 kustomization에 대해 `kustomize build`와 kubeconform 검사를 돌린다.
