# QR 수신기 (폰)

PC 화면에서 재생되는 애니메이션 QR을 **폰 카메라로 실시간 해독**해서 파일로 복원하는 웹앱입니다. 서버 없이 폰 안에서만 처리됩니다.

## 실행
- GitHub Pages(HTTPS) 주소를 안드로이드 크롬에서 열거나, 로컬에서 `python3 -m http.server 8000` 후 `http://localhost:8000` (localhost 는 카메라 허용).
- **시작** → 카메라 허용 → PC의 QR 재생을 미리보기에 맞춤 → 100%가 되면 **내려받기**.
- 프레임을 놓치면 `record.html`(녹화 → 해독)을 사용하세요. QR은 2바퀴 이상 촬영하세요.

QR 인식은 `vendor/zxing-wasm` (MIT) 을 사용합니다.
