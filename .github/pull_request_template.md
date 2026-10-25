## 변경 요약

## WBS ID · 기능 ID

## 종류
- [ ] 설정 값(ConfigMap) / - [ ] 매니페스트(base) / - [ ] 플랫폼(차트·버전) / - [ ] 롤백(이미지 태그 revert)

## 배포 영향
- 대상 Application:
- 블루/그린 대상(gateway·booking)이면 다른 서비스 배포와 겹치지 않는지 (동시 블루/그린 금지)
- [ ] `kustomize build` 결과 확인 (gitops-validate)
- [ ] 계정 ID·AWS 엔드포인트·레지스트리·키 없음 (Public 레포 — 값은 SeatSAC Terraform. gitops-validate가 검사)
