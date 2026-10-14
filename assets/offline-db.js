/* =========================================================
   離線測試模式：模擬 Supabase（資料存在本機瀏覽器）
   ---------------------------------------------------------
   • 只在 config.js 設定 OFFLINE: true 時使用
   • 提供與 Supabase 相同的呼叫介面，頁面程式完全不用改
   • 模擬多位使用者（左下角可切換身分）與資料庫權限規則（同 schema.sql）：
       - 專案／需求：擁有者全權；被分享者只能查看＋新增追蹤；管理員可看全部
       - 追蹤紀錄：只有撰寫人能修改／刪除
       - 唯讀成員：只能查看
   ========================================================= */
(function () {
    'use strict';
    const DB_KEY = 'pm_offline_db_v4';
    const IMG_KEY = 'pm_offline_images_v4';
    const USER_KEY = 'pm_offline_user';

    // 測試身分
    const USERS = [
        { id: '00000000-0000-4000-8000-0000000000a1', email: 'sam@local', name: 'Sam（專案擁有者）', role: 'editor' },
        { id: '00000000-0000-4000-8000-0000000000a2', email: 'wayne@local', name: 'Wayne（被分享者）', role: 'editor' },
        { id: '00000000-0000-4000-8000-0000000000a3', email: 'boss@local', name: '王經理（管理員）', role: 'admin' },
        { id: '00000000-0000-4000-8000-0000000000a4', email: 'guest@local', name: '訪客（唯讀）', role: 'viewer' }
    ];
    let current = (() => { try { return USERS.find(u => u.email === localStorage.getItem(USER_KEY)) || USERS[0]; } catch (e) { return USERS[0]; } })();
    const me = () => current;

    const TABLES = ['app_members', 'app_settings', 'people', 'projects', 'project_modules', 'project_tasks', 'project_records',
        'project_shares', 'requirements', 'requirement_discussions', 'requirement_shares'];
    const PK = { app_settings: ['key'], app_members: ['email'], project_shares: ['project_id', 'email'], requirement_shares: ['requirement_id', 'email'] };
    const pkOf = t => PK[t] || ['id'];
    const HAS_UPDATED = ['people', 'projects', 'requirements', 'app_settings', 'project_records', 'requirement_discussions'];
    const DEFAULTS = {
        app_members: () => ({ role: 'editor', display_name: null, created_at: now() }),
        app_settings: () => ({ updated_at: now() }),
        people: () => ({ id: uuid(), category: '內部單位', email: null, factory: null, note: null, created_at: now(), updated_at: now() }),
        projects: () => ({ id: uuid(), type: null, factory: null, status: '進行中', start_date: null, end_date: null, owner: null, pm: null,
            img_before: null, img_after: null, desc_before: null, desc_after: null, hidden_modules: [], hidden_tasks: [],
            source_requirement_id: null, created_at: now(), updated_at: now() }),
        project_modules: () => ({ id: uuid(), sort_order: 0, owner: null }),
        project_tasks: () => ({ id: uuid(), sort_order: 0, pm: null, owner: null, start_date: null, end_date: null, progress: 0 }),
        project_records: () => ({ id: uuid(), target_module: null, internal_attendees: null, external_attendees: null, created_at: now(), updated_at: now() }),
        project_shares: () => ({ created_at: now() }),
        requirements: () => ({ id: uuid(), factory: null, dept: null, requester: null, status: '需求討論中', created_date: today(), description: null,
            target: null, linked_project_id: null, created_at: now(), updated_at: now() }),
        requirement_discussions: () => ({ id: uuid(), internal: null, external: null, created_at: now(), updated_at: now() }),
        requirement_shares: () => ({ created_at: now() })
    };

    let seq = 0;
    function now() { return new Date(Date.now() + (seq++)).toISOString(); }
    function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function uuid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
    }
    const clone = o => JSON.parse(JSON.stringify(o));
    const err = (message, code) => ({ message, code: code || 'OFFLINE' });
    const rls = t => err(`new row violates row-level security policy for table "${t}"`, '42501');

    /* ---------------- 本機儲存 ---------------- */
    function freshDb() {
        const db = {};
        TABLES.forEach(t => { db[t] = []; });
        USERS.forEach(u => db.app_members.push({ email: u.email, role: u.role, display_name: u.name.replace(/（.*）/, ''), created_at: now() }));
        db.app_settings.push(
            { key: 'dicts', value: { projTypes: ['AMR搬運', '手臂', '系統', '設備改造', '影像辨識'], factories: ['東莞廠', '越南一廠', '越南二廠', '台灣廠'],
                recordTypes: ['當面會議', '線上會議', '現場場勘', '資料審查整理', '方案討論變動', '異常狀況'] }, updated_at: now() },
            { key: 'rules', value: { delayDays: 7, delayHighlight: true, staleDays: 14, weeklyEmail: false }, updated_at: now() });
        return db;
    }
    function load() {
        try { const raw = localStorage.getItem(DB_KEY); if (raw) { const db = JSON.parse(raw); TABLES.forEach(t => { db[t] = db[t] || []; }); return db; } }
        catch (e) { console.warn('離線資料讀取失敗，重新建立', e); }
        return freshDb();
    }
    let DB = load();
    function persist() {
        try { localStorage.setItem(DB_KEY, JSON.stringify(DB)); }
        catch (e) { throw err('瀏覽器儲存空間不足（離線模式約 5MB 上限，請減少照片）'); }
    }
    function loadImgs() { try { return JSON.parse(localStorage.getItem(IMG_KEY) || '{}'); } catch (e) { return {}; } }
    function saveImgs(m) {
        try { localStorage.setItem(IMG_KEY, JSON.stringify(m)); }
        catch (e) { throw err('瀏覽器儲存空間不足，照片無法儲存（離線模式約 5MB 上限）'); }
    }

    /* ---------------- 權限規則（與 schema.sql 相同） ---------------- */
    const role = () => { const m = DB.app_members.find(x => x.email === me().email); return m ? m.role : null; };
    const isMember = () => !!role();
    const canEdit = () => ['admin', 'editor'].includes(role());
    const isAdmin = () => role() === 'admin';
    const proj = id => DB.projects.find(p => p.id === id);
    const reqOf = id => DB.requirements.find(r => r.id === id);
    const canViewProject = id => { const p = proj(id); return isMember() && !!p && (p.owner_id === me().id || isAdmin() || DB.project_shares.some(s => s.project_id === id && s.email === me().email)); };
    const ownsProject = id => { const p = proj(id); return canEdit() && !!p && p.owner_id === me().id; };
    const canViewReq = id => { const r = reqOf(id); return isMember() && !!r && (r.owner_id === me().id || isAdmin() || DB.requirement_shares.some(s => s.requirement_id === id && s.email === me().email)); };
    const ownsReq = id => { const r = reqOf(id); return canEdit() && !!r && r.owner_id === me().id; };
    const modProject = mid => { const m = DB.project_modules.find(x => x.id === mid); return m ? m.project_id : null; };

    const POLICY = {
        app_members: { select: () => isMember(), insert: () => isAdmin(), update: () => isAdmin(), delete: () => isAdmin() },
        app_settings: { select: () => isMember(), insert: canEdit, update: canEdit, delete: canEdit },
        people: { select: () => isMember(), insert: canEdit, update: canEdit, delete: canEdit },
        projects: { select: r => canViewProject(r.id), insert: r => canEdit() && r.owner_id === me().id,
            update: r => canEdit() && r.owner_id === me().id, delete: r => canEdit() && r.owner_id === me().id },
        project_modules: { select: r => canViewProject(r.project_id), insert: r => ownsProject(r.project_id), update: r => ownsProject(r.project_id), delete: r => ownsProject(r.project_id) },
        project_tasks: { select: r => canViewProject(modProject(r.module_id)), insert: r => ownsProject(modProject(r.module_id)),
            update: r => ownsProject(modProject(r.module_id)), delete: r => ownsProject(modProject(r.module_id)) },
        project_records: { select: r => canViewProject(r.project_id), insert: r => canEdit() && canViewProject(r.project_id) && r.created_by === me().id,
            update: r => canEdit() && r.created_by === me().id, delete: r => canEdit() && r.created_by === me().id },
        project_shares: { select: r => ownsProject(r.project_id) || r.email === me().email || isAdmin() || (proj(r.project_id) || {}).owner_id === me().id,
            insert: r => ownsProject(r.project_id) && r.email !== me().email, update: () => false, delete: r => ownsProject(r.project_id) || r.email === me().email },
        requirements: { select: r => canViewReq(r.id), insert: r => canEdit() && r.owner_id === me().id,
            update: r => canEdit() && r.owner_id === me().id, delete: r => canEdit() && r.owner_id === me().id },
        requirement_discussions: { select: r => canViewReq(r.requirement_id), insert: r => canEdit() && canViewReq(r.requirement_id) && r.created_by === me().id,
            update: r => canEdit() && r.created_by === me().id, delete: r => canEdit() && r.created_by === me().id },
        requirement_shares: { select: r => ownsReq(r.requirement_id) || r.email === me().email || isAdmin() || (reqOf(r.requirement_id) || {}).owner_id === me().id,
            insert: r => ownsReq(r.requirement_id) && r.email !== me().email, update: () => false, delete: r => ownsReq(r.requirement_id) || r.email === me().email }
    };

    /* ---------------- 觸發器（擁有者／撰寫人由系統填入，不可竄改） ---------------- */
    function beforeInsert(t, row) {
        if (t === 'projects' || t === 'requirements') { row.owner_id = me().id; row.owner_email = me().email; }
        if (t === 'project_records' || t === 'requirement_discussions') { row.created_by = me().id; row.author_email = me().email; }
        if ((t === 'project_shares' || t === 'requirement_shares') && row.email) { row.email = row.email.toLowerCase(); row.shared_by = me().id; }
        if (t === 'app_members' && row.email) row.email = row.email.toLowerCase();
        if (t === 'project_tasks') row.progress = Math.max(0, Math.min(100, Number(row.progress) || 0));
    }
    function beforeUpdate(t, oldRow, row) {
        if (t === 'projects' || t === 'requirements') { if (oldRow.owner_id) row.owner_id = oldRow.owner_id; row.owner_email = oldRow.owner_email || row.owner_email; }
        if (t === 'project_records' || t === 'requirement_discussions') { if (oldRow.created_by) row.created_by = oldRow.created_by; row.author_email = oldRow.author_email || row.author_email; }
        if (HAS_UPDATED.includes(t)) row.updated_at = now();
        if (t === 'project_tasks') row.progress = Math.max(0, Math.min(100, Number(row.progress) || 0));
    }
    function checkRow(t, row) {
        if (t === 'people' && row.email) {
            const dup = DB.people.find(p => p.id !== row.id && (p.email || '').toLowerCase() === row.email.toLowerCase());
            if (dup) throw err('duplicate key value violates unique constraint "people_email_uniq"', '23505');
        }
        if (t === 'projects' && row.start_date && row.end_date && row.end_date < row.start_date)
            throw err('結束日期不可早於起始日期（projects_date_order）', '23514');
    }
    function cascadeDelete(t, rows) {
        const ids = new Set(rows.map(r => r.id));
        if (t === 'projects') {
            DB.requirements.forEach(r => { if (ids.has(r.linked_project_id)) { if (r.status === '已轉專案') r.status = '方案確認成案'; r.linked_project_id = null; } });
            const mods = DB.project_modules.filter(m => ids.has(m.project_id));
            DB.project_modules = DB.project_modules.filter(m => !ids.has(m.project_id));
            cascadeDelete('project_modules', mods);
            DB.project_records = DB.project_records.filter(r => !ids.has(r.project_id));
            DB.project_shares = DB.project_shares.filter(s => !ids.has(s.project_id));
        }
        if (t === 'project_modules') DB.project_tasks = DB.project_tasks.filter(x => !ids.has(x.module_id));
        if (t === 'requirements') {
            DB.requirement_discussions = DB.requirement_discussions.filter(d => !ids.has(d.requirement_id));
            DB.requirement_shares = DB.requirement_shares.filter(s => !ids.has(s.requirement_id));
        }
    }
    const samePk = (t, a, b) => pkOf(t).every(k => a[k] === b[k]);

    /* ---------------- 查詢建構器（Supabase 相容子集） ---------------- */
    class Query {
        constructor(table) { this.t = table; this.op = 'select'; this.filters = []; this.orders = []; this.rng = null; this.payload = null; this.returning = false; }
        select() { if (this.op !== 'select') this.returning = true; return this; }
        order(col, opt) { this.orders.push([col, !opt || opt.ascending !== false]); return this; }
        range(a, b) { this.rng = [a, b]; return this; }
        eq(col, v) { this.filters.push(r => String(r[col]) === String(v)); return this; }
        not(col, op, v) { if (op === 'is' && v === null) this.filters.push(r => r[col] !== null && r[col] !== undefined); return this; }
        insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
        upsert(rows) { this.op = 'upsert'; this.payload = rows; return this; }
        update(row) { this.op = 'update'; this.payload = row; return this; }
        delete() { this.op = 'delete'; return this; }
        then(resolve, reject) { return Promise.resolve().then(() => this.exec()).then(resolve, reject); }
        exec() {
            const t = this.t, P = POLICY[t];
            if (!DB[t]) return { data: null, error: err('找不到資料表 ' + t) };
            const snapshot = JSON.stringify(DB);
            try {
                const match = r => this.filters.every(f => f(r));
                let data = null;
                if (this.op === 'select') {
                    let rows = DB[t].filter(r => match(r) && P.select(r));
                    this.orders.slice().reverse().forEach(([c, asc]) => {
                        rows = rows.slice().sort((a, b) => {
                            const x = a[c], y = b[c];
                            if (x === y) return 0;
                            if (x === null || x === undefined) return asc ? 1 : -1;
                            if (y === null || y === undefined) return asc ? -1 : 1;
                            return (x < y ? -1 : 1) * (asc ? 1 : -1);
                        });
                    });
                    if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
                    data = clone(rows);
                } else if (this.op === 'insert' || this.op === 'upsert') {
                    const out = [];
                    (Array.isArray(this.payload) ? this.payload : [this.payload]).forEach(input => {
                        const row = {};
                        Object.keys(input).forEach(k => { if (input[k] !== undefined) row[k] = clone(input[k]); });
                        if (t === 'app_members' && row.email) row.email = row.email.toLowerCase();
                        if ((t === 'project_shares' || t === 'requirement_shares') && row.email) row.email = row.email.toLowerCase();
                        const pk = pkOf(t);
                        if (pk.length === 1 && row[pk[0]] === null) throw err(`null value in column "${pk[0]}" of relation "${t}" violates not-null constraint`, '23502');
                        const existing = pk.every(k => row[k] !== undefined) ? DB[t].find(r => samePk(t, r, row)) : null;
                        if (existing) {
                            if (this.op === 'insert') throw err(`duplicate key value violates unique constraint "${t}_pkey"`, '23505');
                            if (!P.select(existing) || !P.update(existing)) throw rls(t);
                            const merged = Object.assign({}, existing, row);
                            beforeUpdate(t, existing, merged);
                            if (!P.update(merged)) throw rls(t);
                            checkRow(t, merged);
                            Object.assign(existing, merged);
                            out.push(existing);
                        } else {
                            const full = Object.assign(DEFAULTS[t](), row);
                            beforeInsert(t, full);
                            if (!P.insert(full)) throw rls(t);
                            checkRow(t, full);
                            DB[t].push(full);
                            out.push(full);
                        }
                    });
                    if (this.returning) data = clone(out);
                } else if (this.op === 'update') {
                    const out = [];
                    DB[t].filter(r => match(r) && P.select(r) && P.update(r)).forEach(r => {      // 無權限的列會被靜默略過（同 PostgreSQL）
                        const merged = Object.assign({}, r, clone(this.payload));
                        beforeUpdate(t, r, merged);
                        if (!P.update(merged)) throw rls(t);
                        checkRow(t, merged);
                        Object.assign(r, merged);
                        out.push(r);
                    });
                    if (this.returning) data = clone(out);
                } else if (this.op === 'delete') {
                    const gone = DB[t].filter(r => match(r) && P.select(r) && P.delete(r));
                    const goneSet = new Set(gone);
                    DB[t] = DB[t].filter(r => !goneSet.has(r));
                    cascadeDelete(t, gone);
                }
                if (this.op !== 'select') persist();
                return { data, error: null };
            } catch (e) {
                DB = JSON.parse(snapshot);             // 失敗時回復，等同資料庫交易
                return { data: null, error: e && e.message ? e : err(String(e)) };
            }
        }
    }

    /* ---------------- save_project（與 schema.sql 的函式邏輯相同） ---------------- */
    function saveProject(p) {
        const pid = p.id || uuid();
        const base = { name: p.name, type: p.type ?? null, factory: p.factory ?? null, status: p.status || '進行中',
            start_date: p.start_date || null, end_date: p.end_date || null, owner: p.owner ?? null, pm: p.pm ?? null };
        let row = proj(pid);
        if (row && POLICY.projects.select(row)) {
            if (!ownsProject(pid)) throw rls('projects');
            const merged = Object.assign({}, row, base);
            ['img_before', 'img_after', 'desc_before', 'desc_after'].forEach(k => { if (p[k] !== null && p[k] !== undefined) merged[k] = p[k]; });
            if ('hidden_modules' in p) merged.hidden_modules = p.hidden_modules || [];
            if ('hidden_tasks' in p) merged.hidden_tasks = p.hidden_tasks || [];
            beforeUpdate('projects', row, merged);
            checkRow('projects', merged);
            Object.assign(row, merged);
        } else {
            if (row) throw err('duplicate key value violates unique constraint "projects_pkey"', '23505');
            row = Object.assign(DEFAULTS.projects(), base, { id: pid,
                img_before: p.img_before ?? null, img_after: p.img_after ?? null, desc_before: p.desc_before ?? null, desc_after: p.desc_after ?? null,
                hidden_modules: p.hidden_modules || [], hidden_tasks: p.hidden_tasks || [], source_requirement_id: p.source_requirement_id || null });
            beforeInsert('projects', row);
            if (!POLICY.projects.insert(row)) throw rls('projects');
            checkRow('projects', row);
            DB.projects.push(row);
        }
        if (Array.isArray(p.modules)) {
            const keep = new Set(p.modules.map(m => m.id).filter(Boolean));
            const removed = DB.project_modules.filter(m => m.project_id === pid && !keep.has(m.id));
            DB.project_modules = DB.project_modules.filter(m => !(m.project_id === pid && !keep.has(m.id)));
            cascadeDelete('project_modules', removed);
            p.modules.forEach((m, mi) => {
                const mid = m.id || uuid();
                const mod = DB.project_modules.find(x => x.id === mid);
                if (mod) Object.assign(mod, { project_id: pid, sort_order: mi, name: m.name, owner: m.owner ?? null });
                else DB.project_modules.push(Object.assign(DEFAULTS.project_modules(), { id: mid, project_id: pid, sort_order: mi, name: m.name, owner: m.owner ?? null }));
                const tasks = m.tasks || [];
                const keepT = new Set(tasks.map(x => x.id).filter(Boolean));
                DB.project_tasks = DB.project_tasks.filter(x => !(x.module_id === mid && !keepT.has(x.id)));
                tasks.forEach((t, ti) => {
                    const r = { module_id: mid, sort_order: ti, name: t.name, pm: t.pm ?? null, owner: t.owner ?? null,
                        start_date: t.start_date || null, end_date: t.end_date || null, progress: Math.max(0, Math.min(100, Number(t.progress) || 0)) };
                    const ex = t.id && DB.project_tasks.find(x => x.id === t.id);
                    if (ex) Object.assign(ex, r);
                    else DB.project_tasks.push(Object.assign(DEFAULTS.project_tasks(), r, { id: t.id || uuid() }));
                });
            });
            const modIds = new Set(DB.project_modules.filter(m => m.project_id === pid).map(m => m.id));
            const taskIds = new Set(DB.project_tasks.filter(t => modIds.has(t.module_id)).map(t => t.id));
            row.hidden_modules = (row.hidden_modules || []).filter(h => modIds.has(h));
            row.hidden_tasks = (row.hidden_tasks || []).filter(h => taskIds.has(h));
        }
        return pid;
    }

    function rpc(fn, args) {
        return Promise.resolve().then(() => {
            if (fn === 'my_role') return { data: role(), error: null };
            if (fn === 'is_member') return { data: isMember(), error: null };
            if (fn === 'can_edit') return { data: canEdit(), error: null };
            if (fn === 'is_admin') return { data: isAdmin(), error: null };
            if (fn === 'save_project') {
                const snapshot = JSON.stringify(DB);
                try { const id = saveProject(args.p); persist(); return { data: id, error: null }; }
                catch (e) { DB = JSON.parse(snapshot); return { data: null, error: e && e.message ? e : err(String(e)) }; }
            }
            return { data: null, error: err('離線模式不支援函式 ' + fn) };
        });
    }

    /* ---------------- 照片（以 data URL 存在本機） ---------------- */
    const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
    const photoProject = path => String(path || '').split('/')[0];
    function storageBucket() {
        return {
            upload: async (path, blob) => {
                if (!ownsProject(photoProject(path))) return { data: null, error: rls('objects') };
                try { const m = loadImgs(); m[path] = await blobToDataUrl(blob); saveImgs(m); return { data: { path }, error: null }; }
                catch (e) { return { data: null, error: e && e.message ? e : err(String(e)) }; }
            },
            createSignedUrls: async paths => {
                const m = loadImgs();
                return { data: paths.map(p => ({ path: p, signedUrl: canViewProject(photoProject(p)) ? (m[p] || null) : null, error: m[p] ? null : 'not found' })), error: null };
            },
            remove: async paths => { const m = loadImgs(); paths.filter(p => ownsProject(photoProject(p)) || !proj(photoProject(p))).forEach(p => delete m[p]); try { saveImgs(m); } catch (e) {} return { data: [], error: null }; }
        };
    }

    /* ---------------- 登入（離線模式：以目前選擇的測試身分登入） ---------------- */
    const userObj = () => ({ id: me().id, email: me().email, aud: 'authenticated', role: 'authenticated' });
    const session = () => ({ access_token: 'offline', token_type: 'bearer', user: userObj() });
    const auth = {
        getSession: async () => ({ data: { session: session() }, error: null }),
        getUser: async () => ({ data: { user: userObj() }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithPassword: async () => ({ data: { session: session(), user: userObj() }, error: null }),
        signUp: async () => ({ data: { session: session(), user: userObj() }, error: null }),
        signOut: async () => ({ error: null }),
        resetPasswordForEmail: async () => ({ data: {}, error: null }),
        updateUser: async () => ({ data: { user: userObj() }, error: null })
    };

    window.PMOffline = {
        createClient: () => ({ from: t => new Query(t), rpc, auth, storage: { from: storageBucket } }),
        users: USERS.map(u => ({ ...u })),
        current: () => ({ ...me() }),
        // 切換測試身分（seeding 時暫時切換，不寫入 localStorage）
        setUser: (email, remember = true) => {
            const u = USERS.find(x => x.email === email);
            if (!u) return;
            current = u;
            if (remember) { try { localStorage.setItem(USER_KEY, email); } catch (e) {} }
        },
        reset: () => {
            try { [DB_KEY, IMG_KEY, 'pm_offline_seeded_v4'].forEach(k => localStorage.removeItem(k)); } catch (e) {}
            DB = freshDb();
        },
        usageKB: () => {
            try { return Math.round(((localStorage.getItem(DB_KEY) || '').length + (localStorage.getItem(IMG_KEY) || '').length) * 2 / 1024); } catch (e) { return 0; }
        }
    };
})();
