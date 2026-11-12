# ChanRemote — C# 네이티브 호스트 (프로토타입)

Electron 버전의 1fps 버벅임을 없애기 위한 **네이티브 재작성**이에요.
화면을 **ffmpeg(H.264 하드웨어 인코딩)**으로 캡처해서, 브라우저에서 **WebCodecs로 하드웨어 디코딩**해 그려요.

> 지금은 **1단계: 같은 와이파이** 프로토타입이에요. 성능(fps)이 실제로 좋아지는지 먼저 확인하는 게 목적이에요.
> 잘 되면 2단계로 원격 접속(PC ID·중계망)과 UI를 붙여요.

## 제일 쉬운 방법 — 빌드된 파일 받기

GitHub Actions가 윈도우에서 빌드해서 **ffmpeg까지 포함한 zip**을 만들어요.
저장소 → Releases → `ChanRemote C# 프로토타입` → `ChanRemoteHost-win64.zip` 받기.

1. 압축을 풀어요.
2. `ChanRemoteHost.exe` 실행 (검은 콘솔 창이 떠요).
3. 창에 나온 주소(예: `http://192.168.0.10:8787`)를 **폰 크롬**에서 열어요.
4. 화면이 뜨면 터치로 조작해요. 왼쪽 위 **fps**를 보세요(30 근처면 성공).

## 직접 고치고 빌드하기 (Visual Studio)

찬민 님이 코드를 바꿔서 쓰시려면:

1. `csharp/ChanRemoteHost/ChanRemoteHost.csproj`를 Visual Studio로 열어요 (.NET 8).
2. `ffmpeg.exe`를 구해서 빌드 결과 폴더(또는 exe 옆)에 둬요.
   - 다운로드: https://www.gyan.dev/ffmpeg/builds/ (`full` 빌드 — GPU 캡처 ddagrab 포함)
3. F5로 실행.

### 성능 높이기 — 내 그래픽에 맞는 인코더로 바꾸기

처음 실행하면 exe 옆에 **`config.json`**이 생겨요. 메모장으로 열어 `Encoder`를 바꾸세요:

| 값 | 설명 |
|---|---|
| `cpu` | 어디서나 동작 (기본). 화면 캡처·인코딩을 CPU로 — 가장 호환성 좋지만 제일 느림 |
| `nvidia` | NVIDIA 그래픽카드 — GPU로 캡처·인코딩 (가장 빠르고 저지연) |
| `intel` | 인텔 내장그래픽 (QuickSync) |
| `amd` | AMD 그래픽카드 |

`Fps`, `BitrateMbps`도 바꿀 수 있어요. GPU 인코더로 바꾸면 체감이 확 달라져요.

## 파일 구조 (수정 포인트)

```
ChanRemoteHost/
  Program.cs          시작점 — 전체 연결
  Config.cs           설정 + ffmpeg 명령어 생성 (인코더 바꾸려면 여기)
  ScreenEncoder.cs    ffmpeg 실행 + H.264 프레임 분리
  InputInjector.cs    마우스·키보드 주입 (SendInput, 절대좌표)
  WebServer.cs        HTTP + WebSocket 서버 (관리자 권한 불필요)
  WsClient.cs         접속자별 전송/수신, 밀리면 프레임 버리기
  wwwroot/
    index.html        뷰어 화면
    app.js            WebCodecs 디코딩 + 터치/마우스/키보드 입력
```

## 다음 단계 (아직 없음)

- [ ] PC ID·비밀번호, 관리자 로그인 (Electron 버전 기능 이식)
- [ ] 밖(LTE)에서 접속 — 중계망/WebRTC 데이터채널
- [ ] 트레이 상주 + 무인 접속 + 커튼 모드
- [ ] 한글 IME 입력(현재는 물리 키 위주), 다중 모니터

## 알아둘 점

- ffmpeg가 없거나 경로가 틀리면 콘솔에 에러가 떠요. `config.json`의 `FfmpegPath` 확인.
- GPU 인코더(nvidia/intel/amd)는 그래픽 드라이버·ffmpeg 빌드에 따라 명령어 조정이 필요할 수 있어요. 콘솔 에러를 보내주면 맞춰 드릴게요.
- 지금은 **주 모니터**만 캡처해요. 다중 모니터는 다음 단계에서.
