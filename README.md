# 공방 (The Workshop) · Cloudflare 버전

6인 생존 카드 게임: 나와 AI 다섯 명, 보석 카드 60장, 체력은 1.
이 버전에는 **회원가입·로그인**이 있고, 골드·컬렉션·장착한 캐릭터 카드가 **계정에 저장**돼요.

## 폴더 구성

| 파일 | 하는 일 |
| --- | --- |
| `public/index.html` | 게임 페이지 |
| `src/index.js` | 서버: 회원가입, 로그인, 기록 저장, 코드 확인 |
| `wrangler.jsonc` | Cloudflare 설정 (사이트 이름, 저장소) |

## 배포 (처음 한 번)

1. 이 폴더의 파일을 전부 GitHub 저장소에 올려요. `public`, `src` 폴더 구조는 그대로 둬야 해요.
2. dash.cloudflare.com → **Workers & Pages** → **Create application** → **GitHub**를 차례로 눌러요. 처음이면 GitHub 로그인 창이 떠요.
3. 이 저장소를 골라요.
4. 프로젝트 이름(Project name)은 반드시 **workshop-game**으로 해요. `wrangler.jsonc`의 `name`과 같아야 배포가 돼요.
5. 나머지 설정은 그대로 두고 **Save and Deploy**를 눌러요.
6. 끝나면 `https://workshop-game.<내-계정>.workers.dev` 주소가 생겨요.

그다음부터는 GitHub에 파일을 올릴 때마다 자동으로 다시 배포돼요.

## 알아 둘 점

- **비밀번호:** PBKDF2(SHA-256, 10만 회)로 해시해서 저장해요. 원래 비밀번호는 서버에도 남지 않아요.
- **로그인 실패 제한:** 5번 연속으로 틀리면 1분 동안 로그인할 수 없어요.
- **코드:** 골드 코드(WELCOME, BOXKIT 등)는 `src/index.js`의 `GOLD_CODES`에만 있어요. 계정마다 한 번씩만 쓸 수 있어요.
- **요금:** 무료 플랜으로 동작해요. 하루 10만 요청까지 쓸 수 있어요.
