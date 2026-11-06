# @yuna/dsh-tool-fs-search-fast

DeepSeek Harness의 `@deepseek-ai/dsh-tool-fs-search` 포크 — 모델에게 노출되는
`glob`/`grep` 도구를 제공하는 플러그인입니다. 도구 이름·스키마·결과 계약은 그대로,
엔진만 훨씬 빠릅니다.

업스트림은 컴파일된 `lib/index.js`만 배포하므로, 이 저장소는 그 번들을 직접
포크하고 변경점을 문서화합니다 (`docs/upstream-README.md`,
`docs/upstream-package.json`은 손대지 않은 업스트림 원본). **베이스: 업스트림
`0.2.2-rc.1`** — 매니페스트 피어가 그 DSH 런타임 버전을 고정하며, 다른 DSH
버전의 프로필은 이 번들을 건너뜁니다([앱 업데이트](#앱-업데이트) 참고).

[English](README.md) · **한국어**

> **설치 방식: 프로필 번들 패키지.** 이 포크는 일반 DSH 플러그인 패키지로,
> `~/.dsh/profiles/<profile>`에 설치됩니다. Electron `app.asar` 안에 들어가지
> 않습니다. `app.asar` 재작성은 폐기됐습니다 — 레거시 방식과 폐기 이유는
> [docs/ASAR.md](docs/ASAR.md) 참고.

## 얼마나 빨라졌나

DSH 도구 자체를 통해 end-to-end 측정, 18코어 Apple Silicon, 웜 캐시:

- 116만 파일 트리에서 `glob **/*.ts`: **7.25 s → 0.18 s** (~40배)
- 같은 트리에서 `grep import`: **1.26 s 후 `SEARCH_RAW_OUTPUT_OVERFLOW` → 50 ms**, 250 매치
- 62k 파일 저장소에서 `glob **/*.ts`: **0.70 s → 0.13 s** (~5배)
- 2파일 트리에서 순정 바이너리 대비 고정 오버헤드: **+4–6 ms**
- 프루닝할 것이 없는 1.34M 파일(검색 루트가 제외 디렉터리 안): **4.1 s → 1.6 s** (~2.6배)

768스레드 호스트(AMD EPYC 9965, Node 22, rg 14.1.1, 웜 캐시) 실측:

| 케이스 | 업스트림 | 이 포크 | |
| --- | --- | --- | --- |
| `glob **/*.ts`, 118만 파일 (98%가 `node_modules`) | 2,633 ms | **78 ms** | 34배 |
| `glob **/*`, 134만 파일, 프루닝 비활성 | 4,144 ms | **1,564 ms** | 2.6배 |
| `grep import`, 98만 파일 | 883 ms, 615 MB 수집 | **36 ms**, 250 매치 | 25배 |
| `grep a`, 98만 파일 | 18,816 ms, 35 GB 수집 | **674 ms**, 250 매치 | 28배 |

업스트림의 두 가지 argv/파이프라인 선택이 지연을 지배합니다:

| 업스트림 | 문제 |
| --- | --- |
| `rg --files --glob=<p> --sort=modified --no-ignore --hidden` | `--sort=modified`가 ripgrep을 **단일 스레드**로 강제하고, 방문하는 모든 파일을 그 한 스레드에서 stat합니다. `--no-ignore`는 `node_modules` 같은 디렉터리까지 순회합니다 |
| `rg --json …`을 **전부** 수집한 뒤 앞 N개만 남김 | 큰 트리에서 넓은 패턴을 돌리면 20 MB 원출력 상한을 넘겨 결과를 하나도 못 보여주고 `SEARCH_RAW_OUTPUT_OVERFLOW`로 실패합니다 |

18코어 Apple Silicon, 웜 캐시 기준 측정:

| 호출 | 업스트림 | 이 포크 | 배속 |
| --- | --- | --- | --- |
| 116만 파일 트리에서 `glob **/*.ts` (95%가 산출물 디렉터리) | 7252 ms | ~180 ms | **~40배** |
| 같은 트리에서 `grep import` | 1.26 s 후 오버플로 오류 | ~50 ms, 250 매치 | **~25배** |
| 62k 파일 저장소에서 `glob **/*.ts` | ~700 ms | ~130 ms | **~5배** |

## `lib/index.js` 변경점

1. `buildGlobCommand`: `--sort=modified` 제거, `--threads=0` 추가, 그리고
   설정 가능한 산출물 디렉터리(`globExcludeDirs`, 기본값
   `node_modules .venv venv __pycache__ .next .nuxt .turbo .cache Pods .gradle
   target`)를 호출자의 `--glob` 패턴 **뒤에** 붙입니다 — ripgrep은 마지막
   매치가 이기므로 순서가 중요하고, 앞에 붙이면 넓은 패턴에서 프루닝이 무효가
   됩니다.
2. `sortPathsByMtime` 추가: 기존 단일 스레드 정렬이 만들던 "수정 시간 순서"
   (mtime **오름차순**, `rg --sort=modified`의 정확한 의미)를 **나노초**
   정밀도와 안정 정렬로 복원합니다. stat 팬아웃은 **워커 스레드**에서 돕니다
   (워커 안의 `fs.statSync`는 메인 스레드 libuv 풀의 기본 4개 동시 호출 제한을
   받지 않음). 8,192개 미만은 인라인 경로로 처리합니다.
3. `isInsideExcludedDir` 추가: 이미 프루닝된 디렉터리 안을 `path`로 명시하면
   그 호출에서는 프루닝을 끕니다. 의도적인 검색은 그대로 동작합니다.
4. `runRipgrepStreaming` 추가: `grep`이 NDJSON 스트림을 중계하면서 매치 상한에서
   ripgrep을 종료합니다. 전체 스트림을 subprocess 경계로 모으던 방식 대신입니다.
   출력은 전체 실행의 정확한 접두사(레코드 단위 검증)이므로 first-N 계약은
   그대로입니다.
5. `Config`에 `globExcludeDirs` 추가, glob 도구 설명에 프루닝 동작 명시. 그 외
   (스키마·retention·spill·표현·에러 어휘·exit code 처리)는 업스트림 코드 그대로.
6. 업스트림 `0.2.2-rc.1`로 리베이스: 업스트림이 새로 넣은 두 동작을 이 번들에
   포함합니다 — 리터럴 디렉터리 프리픽스 프루닝(`--glob=!**` + `--glob={dir,...}/`,
   맨 앞에 두어 호출자 패턴이 여전히 last-match-wins)과 `grep`의 빈 `include`
   처리. 산출물 디렉터리 glob은 계속 호출자 패턴 뒤에 붙습니다.

## 프로필 번들 패키지로 설치

이 패키지는 DSH **번들**입니다: `package.json`에 `dsh.bundle.patch`가 있고,
번들 레이어(`cordis.patch.yml`)가 빠른 행을 삽입합니다. 런타임에 필요한 것
(`@deepseek-ai/*` 피어, `@vscode/ripgrep`)은 모두 **peerDependency**라서 프로필
런타임이 DSH 설치본에서 해석합니다. 내려받는 것이 없고, 포크는 앱이 배포한
ripgrep 바이너리를 그대로 씁니다.

### 프로필 형태

```
~/.dsh/profiles/<profile>/
  package.json
    dependencies["@yuna/dsh-tool-fs-search-fast"] =
      "git+https://github.com/conankun/dsh-tool-fs-search-fast.git#main"
    dsh.profile.bundles += "@yuna/dsh-tool-fs-search-fast"
  cordis.patch.yml
    - id: tool-fs-search
      name: '@deepseek-ai/dsh-tool-fs-search'
      disabled: true                     # glob/grep 제공자는 정확히 하나
  node_modules/@yuna/dsh-tool-fs-search-fast/   pnpm이 설치
```

### 절차

1. 프로필에 패키지를 설치:
   `pnpm add "git+https://github.com/conankun/dsh-tool-fs-search-fast.git#main"`
   (개발 중에는 로컬 체크아웃을 `file:` 의존성으로 걸어도 동일하게 동작합니다.)
2. `dsh.profile.bundles`에 `"@yuna/dsh-tool-fs-search-fast"` 추가 —
   `@deepseek-ai/dsh-base` **뒤에** 둬야 스톡 행이 존재한 상태에서 프로필
   레이어가 비활성화할 수 있습니다.
3. 프로필 `cordis.patch.yml`에 위 `disabled: true` 행 추가.
4. DSH 재시작: 플러그인 트리는 부팅 시 합성됩니다.

부팅 없이 확인:

```
dsh --profile <profile> --dump-config | grep -A3 tool-fs-search
# == @yuna/dsh-tool-fs-search-fast   <- 삽입됨
# - id: tool-fs-search                  <- 스톡 행, disabled: true
```

### Electron이 관리하는 프로필

`dsh plugin --profile desktop …`은 거부됩니다("profile desktop is managed
exclusively by the Electron application"). 데스크톱 프로필은 위처럼
`package.json`과 `cordis.patch.yml`을 직접 편집한 뒤 앱을 재시작합니다.

### 앱 업데이트

설치는 `~/.dsh`에 있어 앱 업데이트가 건드리지 않습니다. 따라서 포크는 **DeepSeek
Harness 업데이트 후에도 살아남습니다** — 업데이트가 지워버리는 (폐기된)
`app.asar` 패치와 다른 점입니다. 바뀔 수 있는 것은 플러그인 API입니다. 피어가
이 번들을 리베이스한 앱 버전 `0.2.2-rc.1`에 맞춰져 있으므로, DSH 릴리스 후에는
프로필 로더가 옛 핀을 unmet으로 보고 **번들을 건너뜁니다**(glob/grep은 조용히
스톡 제공자로 폴백). 따라서 새 업스트림 `lib/index.js`로 리베이스하고 피어를
갱신한 뒤 `pnpm update @yuna/dsh-tool-fs-search-fast`(또는 `#main` 갱신)와
새 앱에 대한 `npm test`를 돌립니다.

## 설정

엔트리 설정은 프로필 레이어에서 패치합니다(번들 기본값은 이 저장소의
`cordis.patch.yml`):

```yaml
- id: tool-fs-search-fast
  config:
    sampleOverCapGlobResults: false
    globExcludeDirs: []        # [] = 업스트림과 완전히 같은 glob 의미(프루닝 없음)
```

기본값: 산출물 디렉터리 프루닝 켜짐, grep은 250 매치에서 중단. 스톡
`tool-fs-search`에 `disabled: true` 행을 두어 `glob`/`grep` 도구 이름의
제공자를 하나로 유지합니다.

## 검증

- 변경마다 `node --check lib/index.js`.
- `npm test` (`test/sandbox.sh`)는 스텁 피어 패키지로 `test/run.mjs`를 돌립니다 —
  오프라인, 앱 설치 불필요 (CI가 이것을 돌립니다).
- `npm run test:app`은 같은 스위트를 Electron-as-node로 실제 `app.asar`에 대해
  돌려 실제 피어 버전까지 검증합니다.
- `rg.real`과의 동등성: 경로 집합 동일, 나노초 mtime이 정확히 같은 파일을
  제외하면 순서도 바이트 단위 동일(ripgrep 자체 tie 순서가 불안정).
- 프로필 설치 검증(실제 부팅): 프로필 쪽 `lib/index.js`를 깨뜨리면 DSH가 그
  경로에서 `failed to import`로 실패 — 앱 번들이 아니라 **프로필 패키지가
  로드된다는 증거**입니다.

## 레거시: `app.asar` 인플레이스 포크

`tools/install.mjs`는 앱 번들의 `@deepseek-ai/dsh-tool-fs-search`를 이 포크로
교체합니다(원본은 `app.asar.bak-fast-<ts>`로 보관, `tools/uninstall.mjs`가
바이트 단위로 복원). 폐기됐습니다: 앱 업데이트에 지워지고, 위 번들 설치는
아카이브 수술이 필요 없습니다. 프로필 패키지를 로드할 수 없는 앱 빌드를 위해
도구만 남겨둡니다 — [docs/ASAR.md](docs/ASAR.md) 참고.

## 라이선스

MIT — 업스트림 패키지 라이선스를 승계합니다. [LICENSE](LICENSE) 참고.