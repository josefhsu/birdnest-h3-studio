# 鳥巢 H3 大師 · Birdnest H3 Studio

**繁體中文** · [English](README.en.md)

鳥巢 H3 大師是 MiniMax H3 的網頁創作室。創作者在瀏覽器整理提示詞和參考素材，管理員透過 Google Colab 啟動 GPU，由 ComfyUI 和 H3 Toybox 執行生成。

## 功能

- **影片、圖片與配音**：支援文生影片、首尾格和圖／影／音參考素材。
- **素材卡**：96×96 px 縮圖、放大預覽、滑鼠拖曳排序。重新排序會同步更新提示內的 `@` 標籤，維持素材對應。
- **提示詞**：以繁中編輯，送出時將描述轉英文、中文對白轉簡中。英文對白保留原文。
- **運算管理**：申請 Colab GPU、查看配發與 Drive 掛載狀態、設定運行上限與閒置釋放。
- **作品與靈感庫**：工作清單、生成進度與作品記錄，支援自訂靈感條目。公開版附兩組原創範例。

## 本機開發

需要 Node.js 22.13 以上、npm 與 Python 3。以下指令從儲存庫根目錄執行。

```bash
git clone https://github.com/josefhsu/birdnest-h3-studio.git
cd birdnest-h3-studio
npm ci
npm run build
for migration in drizzle/*.sql; do
  npx wrangler d1 execute DB --local --config dist/server/wrangler.json \
    --persist-to .wrangler/state --file "$migration"
done
cp .dev.vars.example .dev.vars
npm run dev
```

`npm run dev` 會在終端列出網址。遷移適用於新建的本機資料庫，請依檔名順序執行一次。Loopback 開發模式可用 `/signin-with-chatgpt?return_to=/admin` 模擬登入；要進入管理員工作區，仍需通過所設定的 Google 帳號驗證。建置與自動測試可在沒有 GPU、Google OAuth 憑證或 Drive 的環境執行。

## 部署設定

正式部署以 **OpenAI Sites** 的身分驗證入口與 Cloudflare Worker 資源為前提。建立自己的 Sites 專案，綁定 D1 為 `DB`、R2 為 `BUCKET`，按順序將 `drizzle/` 的 SQL 遷移套用到該 D1。公開版的 .openai/hosting.json 只宣告綁定名稱，發布到自己的 Sites 時需填入該專案 ID。

| 變數 | 用途 |
| --- | --- |
| `ADMIN_GOOGLE_EMAIL` | 唯一可完成 Colab 管理驗證的 Google 電郵 |
| `COLAB_OAUTH_CONFIG` | 部署方自己的 Colab 相容 OAuth 用戶端 JSON，含 `installed` 或 `web` 設定 |
| `COLAB_ENCRYPTION_KEY` | 32 位元組的隨機金鑰，使用標準 Base64 編碼，例如以 `openssl rand -base64 32` 產生 |
| `CREATOR_USERNAME` | 創作者登入帳號，預設為 `creator` |
| `CREATOR_SHARED_PASSWORD` | 創作者登入密碼，應使用長而隨機的值 |
| `TRUST_SITES_IDENTITY` | 只有當流量經過會驗證身分並覆寫 `oai-authenticated-user-*` 的 Sites 入口時，才設為 `true`。一般公開 Worker 保持停用 |

應用程式使用 Colab CLI 相容的 OAuth 流程。部署方須備妥與該流程和範圍相容的用戶端，且能使用 Colab GPU 與 Drive。管理員在 `/admin` 完成 Google 驗證後，可到「運算」啟動 GPU、掛載自己的 Drive。創作者由 `/creator` 登入。Colab 會依帳號權限、配額與當時容量配發 GPU，環境安裝、模型下載與生成均有可能消耗運算單元。

## 測試

```bash
npx tsc --noEmit
node --experimental-vm-modules --test tests/colab-controller.test.mjs
python3 tests/test_watchdog.py
```

## 授權與致謝

自行撰寫的應用程式碼與文件採 [MIT 授權](LICENSE)。第三方程式碼、模型及 LoRA 各依其來源授權。公開快照使用範例資料，不含正式站的資料庫、作品、憑證及原有靈感素材包。詳見 [第三方授權與來源](THIRD_PARTY_NOTICES.md)。

感謝 [松音（dseditor／DSLab）](https://github.com/dseditor) 分享 H3 Colab 工作流與 H3 Toybox。
