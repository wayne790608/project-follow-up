# 專案管理系統 v4（GitHub Pages ＋ Supabase 雲端資料庫版）

網頁放在 **GitHub Pages**（免費靜態網站），資料存放在 **Supabase**（免費雲端 PostgreSQL 資料庫）。
每位成員登入後擁有**自己的專案與需求評估資料庫**，可逐一分享給指定同事查看並共同新增追蹤紀錄。

## 👤 個人資料庫與分享規則

| 資料 | 誰看得到 | 誰能修改 |
|---|---|---|
| 專案（基本資料、大項目、細項、進度、照片、甘特圖顯示設定） | 擁有者、被分享的成員、管理員 | **只有擁有者** |
| 需求評估案件（內容、狀態、轉專案） | 擁有者、被分享的成員、管理員 | **只有擁有者** |
| 追蹤紀錄（會議／執行履歷、需求討論） | 看得到該專案／需求的人 | 看得到的人都能**新增**；文字**只有撰寫人**能修改或刪除 |
| 人員與單位名冊、參數字典、預警規則 | 全體成員共用 | 管理員、編輯者 |

- 新建立的專案／需求預設**只有自己**（與管理員）看得到
- 在專案或需求上按「🔗 分享」→ 從成員名單選人；隨時可「取消分享」（對方已寫的追蹤紀錄會保留）
- 被分享者在畫面上會看到「🔗 ○○ 分享給我」，專案的編輯按鈕會自動隱藏，只保留「新增會議記錄／追蹤」
- 每筆追蹤紀錄顯示「✍ 撰寫人」，修改過會標示「已編輯」；自己寫的才有 ✎ 修改按鈕
- 首頁、列表、需求頁上方可篩選「我的／分享給我的」；管理員多一個「其他成員的（管理員）」可查看全部
- 以上規則由資料庫（Row Level Security）強制執行，就算繞過網頁直接呼叫 API 也無法越權

```
GitHub Pages（網頁）  ──登入後讀寫──▶  Supabase（資料庫＋登入＋照片儲存）
```

## 🧪 先用離線模式確認（不需要 Supabase）

目前 `assets/config.js` 預設為 `OFFLINE: true`：

1. 解壓縮後，直接**雙擊 `index.html`** 用 Chrome / Edge 打開即可
2. 第一次開啟會自動載入示範資料，不需要登入。左下角可**切換測試身分**來確認分享與權限：
   - **Sam（專案擁有者）**：擁有示範專案，已分享給 Wayne
   - **Wayne（被分享者）**：看得到 Sam 分享的專案並可新增追蹤，另有一個自己的私人專案
   - **王經理（管理員）**：篩選「其他成員的（管理員）」可看全部，只能新增追蹤
   - **訪客（唯讀）**：沒被分享時什麼都看不到
3. 所有功能（甘特圖顯示設定、新增專案、需求轉專案、人員、報表匯出、備份匯入…）都和正式版相同
4. 資料只存在**這台電腦的這個瀏覽器**；左下角「重置測試資料」可清除並重新載入示範資料

確認沒問題後，把 `OFFLINE` 改成 `false`，再依下方步驟接上 Supabase 並上傳 GitHub。
（離線時測試的資料可在「系統設定 → 備份與匯入」下載 JSON，上線後再匯入雲端。）

> ⚠️ 若 `OFFLINE: true` 的狀態直接放上 GitHub Pages，每個人看到的都是自己瀏覽器裡的資料、彼此不共享，請務必改成 `false`。

## 檔案結構

| 路徑 | 說明 |
|---|---|
| `index.html` 等 7 個頁面 | 系統頁面 |
| `login.html` | 登入／註冊／忘記密碼 |
| `assets/config.js` | **要填寫的唯一設定檔**（Supabase 網址與公開金鑰） |
| `assets/common.js` | 共用資料層（所有讀寫資料庫的程式都在這裡） |
| `assets/csv-import.js` | CSV 問卷表格下載與匯入（需求評估、專案、人員） |
| `assets/offline-db.js` | 離線測試模式用的本機資料庫（模擬 Supabase，`OFFLINE: true` 時才使用） |
| `assets/vendor/supabase.js` | Supabase 官方 JS 套件 v2.117.2（已內含，不依賴外部 CDN） |
| `supabase/schema.sql` | 資料庫結構、權限、照片空間、整理用檢視表 |

---

## 部署步驟（約 20 分鐘）

### 步驟 1：建立 Supabase 專案

1. 到 <https://supabase.com> 用 GitHub 帳號登入 → **New project**
2. 填專案名稱、資料庫密碼（請記下來），Region 建議選 **Southeast Asia (Singapore)**（離台灣、東莞、越南都近）
3. 等待約 2 分鐘建立完成

### 步驟 2：建立資料表

1. 左側選單 **SQL Editor** → **New query**
2. 打開本專案的 `supabase/schema.sql`，**全部複製貼上** → 按 **Run**
3. 看到 `Success. No rows returned` 即完成（此檔可重複執行，不會破壞既有資料）

### 步驟 3：設定第一位管理員

在 SQL Editor 再執行一次（把 Email 換成你要登入的 Email）：

```sql
insert into public.app_members (email, role, display_name)
values (lower('your-email@company.com'), 'admin', '系統管理員')
on conflict (email) do update set role = 'admin';
```

之後新增其他同事，直接在網站「系統設定 → 🔐 成員與權限」操作即可，不用再寫 SQL。

### 步驟 4：填寫連線設定

0. 先把 `OFFLINE: true` 改成 `OFFLINE: false`
1. Supabase 專案首頁上方 **Connect**（或左下 **Project Settings → API Keys**）
2. 複製 **Project URL** 與 **Publishable key**（`sb_publishable_` 開頭；舊版 `eyJ` 開頭的 anon key 將於 2026 年底停用）
3. 編輯 `assets/config.js`：

```js
window.PM_CONFIG = {
    OFFLINE: false,
    SUPABASE_URL: 'https://abcdefgh.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_xxxxxxxx',
    IMAGE_BUCKET: 'project-images'
};
```

> ✅ Publishable key 本來就是設計給網頁公開使用的，放在 GitHub 上沒問題；資料由資料庫權限保護（未在成員名單內的人登入後也看不到任何資料）。
> ⛔ **絕對不要**把 Secret key（`sb_secret_`）或舊版 `service_role` key 放進任何檔案或上傳到 GitHub。

### 步驟 5：上傳到 GitHub 並開啟 Pages

1. GitHub 建立新的 repository（例如 `pm-system`）
2. 把本資料夾**所有檔案**上傳（含 `.nojekyll` 隱藏檔）
   - 網頁操作：repo 頁面 → **Add file → Upload files** → 把資料夾內容拖進去 → Commit
   - 或用指令：
     ```bash
     git init && git add . && git commit -m "專案管理系統 v3"
     git branch -M main
     git remote add origin https://github.com/<你的帳號>/pm-system.git
     git push -u origin main
     ```
3. repo **Settings → Pages** → Source 選 **Deploy from a branch** → Branch 選 `main`、資料夾 `/ (root)` → Save
4. 約 1 分鐘後網址會顯示在同一頁，例如 `https://<你的帳號>.github.io/pm-system/`

### 步驟 6：設定登入回傳網址（重要）

Supabase **Authentication → URL Configuration**：

- **Site URL**：`https://<你的帳號>.github.io/pm-system/login.html`
- **Redirect URLs**：加入 `https://<你的帳號>.github.io/pm-system/**`

（這樣 Email 驗證信、重設密碼信的連結才會回到你的網站。）

### 步驟 7：第一次登入與匯入資料

1. 打開網站 → 登入頁點「**首次使用註冊**」→ 用步驟 3 的 Email 註冊 → 到信箱點驗證連結
2. 登入後到「**系統設定 → 💾 備份與匯入**」：
   - 有舊版（瀏覽器版 v2.x）的資料：先在舊版「系統設定 → 下載完整資料庫備份檔」取得 JSON，再到這裡**匯入**，專案、履歷、需求、人員、照片都會搬到雲端
   - 想先看效果：按「**匯入示範資料**」

---

## 新增同事

1. 管理員到「系統設定 → 🔐 成員與權限」輸入同事 Email、選權限
2. 請同事打開網站 → 「首次使用註冊」→ 收信驗證 → 登入

| 權限 | 可以做什麼 |
|---|---|
| 管理員 | 自己的專案／需求全權；可查看所有人的專案與需求並新增追蹤；管理成員 |
| 編輯者 | 自己的專案／需求全權；被分享的可查看＋新增追蹤；維護人員名冊與參數 |
| 唯讀 | 只能瀏覽被分享的資料與匯出報表（無法新增追蹤） |

> 若不希望外人能自行註冊帳號：Supabase **Authentication → Sign In / Providers → Email** 關閉「Allow new users to sign up」，改由管理員在 **Authentication → Users → Add user** 建立帳號。（就算開放註冊，未列入成員名單的人也看不到任何資料。）

---

## 在 Supabase 後台整理資料

**Table Editor** 可以像 Excel 一樣直接瀏覽、篩選、排序、修改、匯出 CSV：

| 資料表 | 內容 |
|---|---|
| `projects` | 專案基本資料 |
| `project_modules` | 大項目模塊（屬於某專案） |
| `project_tasks` | 細項任務（屬於某模塊） |
| `project_records` | 執行履歷／會議紀錄 |
| `requirements` / `requirement_discussions` | 需求評估案件／討論紀錄 |
| `people` | 人員與廠商名冊 |
| `app_members` | 系統登入成員與權限 |
| `app_settings` | 參數字典（`dicts`）與預警規則（`rules`） |

另有 4 個**中文欄位的整理用檢視表**（唯讀，自動彙整）：
`v_專案總表`、`v_任務明細`、`v_履歷紀錄`、`v_需求評估總表`

案場照片存放於 **Storage → project-images**（私有空間，只有成員看得到）。

刪除專案時，其模塊、細項、履歷會一併刪除；若該專案是由需求案件轉立，需求會自動退回「方案確認成案」。

---

## 備份建議

Supabase 免費方案**不含自動備份**，建議：

- 每月到「系統設定 → 💾 備份與匯入 → 下載完整資料庫備份檔」存一份 JSON
- 備份檔可再匯入（同一份重複匯入不會產生重複資料）

## 免費方案注意事項

- 免費方案的資料庫容量、照片儲存空間與使用人數上限請以 <https://supabase.com/pricing> 為準；以文字為主的專案管理資料，一般部門使用通常相當充裕
- 免費方案的專案若**一段時間沒有人使用可能會被暫停**，到 Supabase 後台按 Restore 即可恢復（資料不會遺失）；正式長期使用建議評估付費方案

## 常見問題

| 狀況 | 解法 |
|---|---|
| 畫面顯示「尚未設定資料庫連線」 | `assets/config.js` 還沒填，或填錯 |
| 「資料載入失敗」 | 確認步驟 2 的 `schema.sql` 有成功執行 |
| 「帳號尚未開通」 | 該 Email 不在成員名單，請管理員新增 |
| 驗證信點了回不到網站 | 檢查步驟 6 的 URL 設定 |
| 照片上傳失敗 | 單張上限 5 MB；系統會先自動壓縮，若仍失敗請換 JPG/PNG |
| 多人同時編輯同一專案 | 儲存時若發現別人剛改過，系統會提示是否覆蓋 |

## 版本更新

更新網站檔案後，若版本說明提到資料庫有變動，到 Supabase SQL Editor **重新執行一次最新的 `supabase/schema.sql`** 即可（可重複執行，不會刪除資料）。

- **v4.0**（⚠️ 需更新資料庫：重新執行 `schema.sql`）：每位成員擁有自己的專案與需求評估；可逐一分享給指定成員（查看＋新增追蹤）；追蹤紀錄可由撰寫人修改文字並標示已編輯；管理員可查看全部但只能新增追蹤。從 v3 升級時，既有專案歸給原建立者，找不到建立者的專案與需求歸給第一位管理員（之後可再分享給相關同事）。「清空全部資料」改為「刪除我擁有的全部資料」。

- **v3.3**（不需更新資料庫）：「項目需求評估」「專案管理項目列表」「人員與單位管理」的「＋ 新增」左側新增「📄 輸出問卷表格」（空白 CSV）與「📥 匯入 CSV」。匯入前逐列檢查並可勾選要匯入的資料；自動辨識 Excel 存成的 UTF-8／Big5／GBK 編碼與 2026/11/1 日期格式。專案表格一列一個細項，同名專案自動合併成大項目與細項。
- **v3.2**（不需更新資料庫）：參數字典可按 ✎ 變更名稱，使用中的專案／需求／人員／紀錄會一併改名；外部廠商免填常駐廠區；人員表頭（類別、單位、姓名、廠區）可點擊 A→Z／Z→A 排序；會議記錄、執行履歷、需求討論的內部／外部與會人員改為可搜尋的多選下拉（可加入名冊外人員）。
- **v3.1**：首頁甘特圖「＋ 選擇顯示大項目／細項」改為浮動選擇器（原本會被甘特圖捲動區裁切而打不開），可逐一勾選大項目與細項、勾選後立即顯示並自動展開；細項 ID 在編輯後保留。資料庫新增 `projects.hidden_tasks` 欄位。
