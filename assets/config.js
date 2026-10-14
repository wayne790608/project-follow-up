/* =========================================================
   Supabase 連線設定（部署手冊 Part C1）
   取得方式：Supabase 專案首頁上方「Connect」，或 Project Settings → API Keys
     - Project URL      → SUPABASE_URL                （https://xxxx.supabase.co）
     - Publishable key  → SUPABASE_PUBLISHABLE_KEY    （sb_publishable_ 開頭）
   ※ Publishable key 本來就設計成可公開放在網頁；資料安全由資料庫的
     Row Level Security（schema.sql 已設定）與登入成員名單保護。
   ※ 絕對不要填 Secret key（sb_secret_ 開頭）或舊版 service_role key！
   ※ 舊版 anon key（eyJ 開頭）也能用，但 Supabase 將於 2026 年底停用。
   ========================================================= */
window.PM_CONFIG = {
    // ★ 離線測試模式：true = 資料存在本機瀏覽器，不需要 Supabase，直接雙擊 index.html 就能確認功能
    //                  false = 正式上線，連到下面的 Supabase 雲端資料庫
    OFFLINE: true,

    SUPABASE_URL: 'https://YOUR-PROJECT-ID.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_YOUR-KEY',
    IMAGE_BUCKET: 'project-images'
};
