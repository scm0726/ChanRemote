#!/usr/bin/env bash
# ChanRemote APK 빌드 (GitHub Actions에서 실행 — 직접 빌드할 땐 Android SDK + JDK 21 필요)
set -euo pipefail
cd "$(dirname "$0")"

npm install --no-audit --no-fund

# 뷰어 웹 파일을 앱 안에 넣기
rm -rf www && mkdir -p www && cp -r ../web/. www/

[ -d android ] || npx cap add android

# 아이콘·시작화면
npx @capacitor/assets generate --android --iconBackgroundColor '#0b0e14' --splashBackgroundColor '#0b0e14' || echo "아이콘 생성 건너뜀"

npx cap sync android

# 전체화면/화면 켜짐 유지 액티비티
cp native/MainActivity.java android/app/src/main/java/com/chanmin/chanremote/MainActivity.java

# 키보드가 뜰 때 화면이 위로 줄어들도록
MANIFEST=android/app/src/main/AndroidManifest.xml
if ! grep -q 'windowSoftInputMode' "$MANIFEST"; then
  sed -i 's#android:name=".MainActivity"#android:name=".MainActivity"\n            android:windowSoftInputMode="adjustResize"#' "$MANIFEST"
fi

# PC와 암호화 없는 ws:// 로 통신 허용 (화면·입력 자체는 WebRTC로 암호화됨)
if ! grep -q 'usesCleartextTraffic' "$MANIFEST"; then
  sed -i 's#<application#<application android:usesCleartextTraffic="true"#' "$MANIFEST"
fi

# 버전 (빌드 번호)
CODE="${GITHUB_RUN_NUMBER:-1}"
sed -i -E "s/versionCode [0-9]+/versionCode ${CODE}/; s/versionName \"[^\"]*\"/versionName \"1.4.${CODE}\"/" android/app/build.gradle

# 항상 같은 서명키 → 새 버전을 덮어서 설치 가능
mkdir -p ~/.android
cp native/debug.keystore ~/.android/debug.keystore

cd android
chmod +x gradlew
./gradlew assembleDebug --no-daemon
cp app/build/outputs/apk/debug/app-debug.apk ../ChanRemote.apk
echo "완료: android-app/ChanRemote.apk"
