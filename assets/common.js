/* =========================================================
   專案管理系統 v3 — 共用資料層（Supabase 雲端資料庫版）
   ---------------------------------------------------------
   • 資料存放於 Supabase (PostgreSQL)，不再使用瀏覽器 localStorage
   • 每頁呼叫 PM.boot(頁面代號, 主程式)：檢查登入 → 讀取全部資料到記憶體 → 繪製頁面
   • 讀取：PM.getProjects() 等「同步」取用記憶體快取
   • 寫入：PM.api.xxx() 為非同步；請透過 PM.act() 執行，完成後會自動重新讀取資料
   ========================================================= */
(function () {
    'use strict';
    const PM = {};
    PM.VERSION = 'v4.0.0';
    const CFG = window.PM_CONFIG || {};
    const BUCKET = CFG.IMAGE_BUCKET || 'project-images';

    PM.PROJECT_STATUSES = ['評估中', '進行中', '專案完成', '專案終止'];
    PM.REQ_STATUSES = ['需求討論中', '現場場勘評估', '方案確認成案', '已轉專案', '暫緩／不成案'];
    PM.ROLE_NAMES = { admin: '管理員', editor: '編輯者', viewer: '唯讀' };
    PM.DEFAULT_DICTS = {
        projTypes: ['AMR搬運', '手臂', '系統', '設備改造', '影像辨識'],
        factories: ['東莞廠', '越南一廠', '越南二廠', '台灣廠'],
        recordTypes: ['當面會議', '線上會議', '現場場勘', '資料審查整理', '方案討論變動', '異常狀況']
    };
    PM.DEFAULT_SETTINGS = { delayDays: 7, delayHighlight: true, staleDays: 14, weeklyEmail: false };

    /* =================== 工具函式 =================== */
    PM.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    PM.clone = o => JSON.parse(JSON.stringify(o));
    PM.newId = () => (crypto.randomUUID ? crypto.randomUUID() :
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
    PM.isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
    PM.fmtDate = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    PM.today = () => PM.fmtDate(new Date());
    PM.parseDate = s => {
        if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
        const [y, m, d] = s.slice(0, 10).split('-').map(Number);
        return new Date(y, m - 1, d);
    };
    PM.daysBetween = (a, b) => Math.round((PM.parseDate(b) - PM.parseDate(a)) / 864e5);
    PM.param = name => new URLSearchParams(location.search).get(name);
    const nz = v => (v === '' || v === undefined ? null : v);

    /* =================== Supabase 連線 =================== */
    // 離線測試模式：config.js 設 OFFLINE: true，資料改存本機瀏覽器（見 assets/offline-db.js）
    PM.offline = !!CFG.OFFLINE && !!window.PMOffline;
    // 金鑰：新版 publishable key（建議）或舊版 anon key 皆可
    const API_KEY = CFG.SUPABASE_PUBLISHABLE_KEY || CFG.SUPABASE_ANON_KEY || '';
    if (/^sb_secret_/.test(API_KEY)) alert('config.js 填入的是 Secret key！這會讓任何人繞過所有權限，請立刻改用 Publishable key，並到 Supabase 刪除這把 Secret key。');
    const configured = PM.offline || (CFG.SUPABASE_URL && !/YOUR-PROJECT/.test(CFG.SUPABASE_URL) && API_KEY && !/YOUR-(ANON|KEY)/.test(API_KEY) && !/^sb_secret_/.test(API_KEY));
    PM.configured = !!configured;
    PM.sb = PM.offline ? window.PMOffline.createClient() : (configured && window.supabase) ? window.supabase.createClient(CFG.SUPABASE_URL, API_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    }) : null;

    async function run(q) {
        const { data, error } = await q;
        if (error) throw error;
        return data;
    }
    // Supabase 預設單次最多回傳 1000 筆，這裡自動分頁讀完
    async function fetchAll(table, orderCols) {
        const out = [];
        const size = 1000;
        for (let from = 0; ; from += size) {
            let q = PM.sb.from(table).select('*');
            orderCols.forEach(c => { q = q.order(c, { ascending: true }); });
            const rows = await run(q.range(from, from + size - 1));
            out.push(...rows);
            if (rows.length < size) break;
        }
        return out;
    }

    /* =================== 記憶體快取 =================== */
    const cache = { members: [], projects: [], reqs: [], people: [], dicts: PM.clone(PM.DEFAULT_DICTS), settings: { ...PM.DEFAULT_SETTINGS } };

    const isExternal = s => /^(https?:|data:)/.test(s || '');

    PM.reload = async function () {
        const [projects, modules, tasks, records, reqs, discs, people, settings, pShares, rShares, members] = await Promise.all([
            fetchAll('projects', ['created_at']),
            fetchAll('project_modules', ['sort_order']),
            fetchAll('project_tasks', ['sort_order']),
            fetchAll('project_records', ['record_date', 'created_at']),
            fetchAll('requirements', ['created_at']),
            fetchAll('requirement_discussions', ['disc_date', 'created_at']),
            fetchAll('people', ['created_at']),
            fetchAll('app_settings', ['key']),
            fetchAll('project_shares', ['created_at']),
            fetchAll('requirement_shares', ['created_at']),
            fetchAll('app_members', ['created_at'])
        ]);
        cache.members = members.map(m => ({ email: m.email, role: m.role, name: m.display_name || '' }));
        const pShareMap = groupBy(pShares, 'project_id'), rShareMap = groupBy(rShares, 'requirement_id');
        const me = PM.user ? PM.user.id : null;

        const tasksByMod = groupBy(tasks, 'module_id');
        const modsByProj = groupBy(modules, 'project_id');
        const recsByProj = groupBy(records, 'project_id');
        const discsByReq = groupBy(discs, 'requirement_id');

        cache.projects = projects.reverse().map(p => {
            const proj = {
                id: p.id, name: p.name, type: p.type || '', factory: p.factory || '', status: p.status,
                start: p.start_date || '', end: p.end_date || '', owner: p.owner || '', pm: p.pm || '',
                imgBefore: p.img_before || '', imgAfter: p.img_after || '',
                imgBeforeUrl: isExternal(p.img_before) ? p.img_before : '', imgAfterUrl: isExternal(p.img_after) ? p.img_after : '',
                descBefore: p.desc_before || '', descAfter: p.desc_after || '',
                hiddenModules: p.hidden_modules || [], hiddenTasks: p.hidden_tasks || [], sourceRequirementId: p.source_requirement_id,
                createdAt: p.created_at, updatedAt: p.updated_at,
                ownerId: p.owner_id, ownerEmail: p.owner_email || '', isMine: !!me && p.owner_id === me,
                shares: (pShareMap[p.id] || []).map(x => x.email),
                modules: (modsByProj[p.id] || []).map(m => ({
                    id: m.id, name: m.name, owner: m.owner || '',
                    subtasks: (tasksByMod[m.id] || []).map(t => ({
                        id: t.id, name: t.name, pm: t.pm || '', owner: t.owner || '',
                        start: t.start_date || '', end: t.end_date || '', progress: t.progress
                    }))
                })),
                records: (recsByProj[p.id] || []).slice().reverse().map(r => ({
                    id: r.id, date: r.record_date, type: r.type, targetModule: r.target_module || '',
                    internalAttendees: r.internal_attendees || '', externalAttendees: r.external_attendees || '', detail: r.detail,
                    createdBy: r.created_by, authorEmail: r.author_email || '', createdAt: r.created_at, updatedAt: r.updated_at
                }))
            };
            proj.progress = PM.calcProjectProgress(proj);
            return proj;
        });

        cache.reqs = reqs.reverse().map(r => ({
            id: r.id, type: r.type, title: r.title, factory: r.factory || '', dept: r.dept || '', user: r.requester || '',
            status: r.status, createdDate: r.created_date, desc: r.description || '', target: r.target || '',
            linkedProjectId: r.linked_project_id,
            ownerId: r.owner_id, ownerEmail: r.owner_email || '', isMine: !!me && r.owner_id === me,
            shares: (rShareMap[r.id] || []).map(x => x.email),
            discussions: (discsByReq[r.id] || []).slice().reverse().map(d => ({
                id: d.id, date: d.disc_date, type: d.type, internal: d.internal || '', external: d.external || '', content: d.content,
                createdBy: d.created_by, authorEmail: d.author_email || '', createdAt: d.created_at, updatedAt: d.updated_at
            }))
        }));

        cache.people = people.reverse().map(u => ({ id: u.id, category: u.category, dept: u.dept, name: u.name, email: u.email || '', factory: u.factory || '', note: u.note || '' }));

        const sMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
        const d = sMap.dicts || {};
        cache.dicts = {
            projTypes: d.projTypes && d.projTypes.length ? d.projTypes : PM.DEFAULT_DICTS.projTypes.slice(),
            factories: d.factories && d.factories.length ? d.factories : PM.DEFAULT_DICTS.factories.slice(),
            recordTypes: d.recordTypes && d.recordTypes.length ? d.recordTypes : PM.DEFAULT_DICTS.recordTypes.slice()
        };
        cache.settings = Object.assign({}, PM.DEFAULT_SETTINGS, sMap.rules || {});

        await signImages();
    };

    // 私有 bucket 的照片需產生有時效的簽章網址才能顯示
    async function signImages() {
        const paths = [];
        cache.projects.forEach(p => {
            if (p.imgBefore && !isExternal(p.imgBefore)) paths.push(p.imgBefore);
            if (p.imgAfter && !isExternal(p.imgAfter)) paths.push(p.imgAfter);
        });
        if (!paths.length) return;
        try {
            const res = await run(PM.sb.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 6));
            const map = Object.fromEntries(res.filter(x => x.signedUrl).map(x => [x.path, x.signedUrl]));
            cache.projects.forEach(p => {
                if (map[p.imgBefore]) p.imgBeforeUrl = map[p.imgBefore];
                if (map[p.imgAfter]) p.imgAfterUrl = map[p.imgAfter];
            });
        } catch (e) { console.warn('照片網址產生失敗', e); }
    }

    function groupBy(rows, key) {
        const m = {};
        rows.forEach(r => { (m[r[key]] = m[r[key]] || []).push(r); });
        return m;
    }

    /* ---------- 同步讀取（回傳複本，避免頁面誤改快取） ---------- */
    PM.getProjects = () => PM.clone(cache.projects);
    PM.getProject = id => { const p = cache.projects.find(x => x.id === id); return p ? PM.clone(p) : null; };
    PM.getRequirements = () => PM.clone(cache.reqs);
    PM.getUsers = () => PM.clone(cache.people);
    PM.getDicts = () => PM.clone(cache.dicts);
    PM.getSettings = () => ({ ...cache.settings });
    PM.getMembers = () => PM.clone(cache.members);

    /* ---------- 個人專案＋分享：權限判斷（與資料庫規則一致） ---------- */
    PM.memberName = email => {
        if (!email) return '—';
        const m = cache.members.find(x => x.email === String(email).toLowerCase());
        return (m && m.name) || String(email).split('@')[0];
    };
    PM.isOwner = item => !!(item && PM.canEdit && PM.user && item.ownerId === PM.user.id);   // 可修改專案／需求本身
    PM.canTrack = item => !!(item && PM.canEdit);                                             // 看得到就能新增追蹤（唯讀成員除外）
    PM.isAuthor = entry => !!(entry && PM.canEdit && PM.user && entry.createdBy === PM.user.id); // 只能改自己寫的追蹤
    PM.isSharedToMe = item => !!(item && PM.user && item.shares.includes(PM.user.email.toLowerCase()));
    PM.scopeOf = item => item.isMine ? 'mine' : PM.isSharedToMe(item) ? 'shared' : 'admin';
    PM.ownerBadge = item => {
        if (item.isMine) return `<span class="own-badge mine" title="${item.shares.length ? '已分享給：' + PM.esc(item.shares.map(PM.memberName).join('、')) : '尚未分享'}">👤 我的${item.shares.length ? `｜已分享 ${item.shares.length} 人` : ''}</span>`;
        if (PM.isSharedToMe(item)) return `<span class="own-badge shared" title="${PM.esc(item.ownerEmail)}">🔗 ${PM.esc(PM.memberName(item.ownerEmail))} 分享給我</span>`;
        return `<span class="own-badge admin" title="${PM.esc(item.ownerEmail)}">👁 ${PM.esc(PM.memberName(item.ownerEmail))} 的（管理員檢視）</span>`;
    };
    PM.authorLine = e => {
        const edited = e.updatedAt && e.createdAt && (new Date(e.updatedAt) - new Date(e.createdAt) > 1000);
        return `<span class="author-tag" title="${PM.esc(e.authorEmail || '')}">✍ ${PM.esc(PM.memberName(e.authorEmail))}${edited ? '・已編輯' : ''}</span>`;
    };
    PM.SCOPES = [['', '全部（我的＋分享給我的）'], ['mine', '我的'], ['shared', '分享給我的']];
    PM.fillScope = sel => {
        if (typeof sel === 'string') sel = document.getElementById(sel);
        sel.innerHTML = PM.SCOPES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('') + (PM.isAdmin ? '<option value="admin">其他成員的（管理員）</option>' : '');
    };

    /* =================== 寫入 API =================== */
    const projectToJson = p => ({
        id: p.id, name: p.name, type: p.type, factory: p.factory, status: p.status,
        start_date: nz(p.start), end_date: nz(p.end), owner: p.owner, pm: p.pm,
        img_before: nz(p.imgBefore), img_after: nz(p.imgAfter), desc_before: p.descBefore ?? null, desc_after: p.descAfter ?? null,
        source_requirement_id: nz(p.sourceRequirementId),
        ...(p.hiddenModules ? { hidden_modules: p.hiddenModules } : {}),
        ...(p.hiddenTasks ? { hidden_tasks: p.hiddenTasks } : {}),
        ...(p.modules ? { modules: p.modules.map(m => ({
            id: m.id, name: m.name, owner: m.owner,
            tasks: (m.subtasks || []).map(t => ({ id: PM.isUuid(t.id) ? t.id : null, name: t.name, pm: t.pm, owner: t.owner, start_date: nz(t.start), end_date: nz(t.end), progress: Number(t.progress) || 0 }))
        })) } : {})
    });

    const FIELD_MAP = { name: 'name', type: 'type', factory: 'factory', status: 'status', start: 'start_date', end: 'end_date', owner: 'owner', pm: 'pm',
        imgBefore: 'img_before', imgAfter: 'img_after', descBefore: 'desc_before', descAfter: 'desc_after', hiddenModules: 'hidden_modules', hiddenTasks: 'hidden_tasks' };

    PM.api = {
        saveProject: async p => run(PM.sb.rpc('save_project', { p: projectToJson(p) })),
        patchProject: async (id, patch) => {
            const row = {};
            Object.keys(patch).forEach(k => { if (FIELD_MAP[k]) row[FIELD_MAP[k]] = patch[k] === '' && /start|end/.test(k) ? null : patch[k]; });
            return run(PM.sb.from('projects').update(row).eq('id', id));
        },
        deleteProject: async id => {
            const p = cache.projects.find(x => x.id === id);
            await run(PM.sb.from('projects').delete().eq('id', id));
            const files = p ? [p.imgBefore, p.imgAfter].filter(x => x && !isExternal(x)) : [];
            if (files.length) await PM.sb.storage.from(BUCKET).remove(files);
        },
        addRecord: async (pid, r) => run(PM.sb.from('project_records').insert({
            id: r.id && PM.isUuid(r.id) ? r.id : undefined,
            project_id: pid, record_date: r.date, type: r.type, target_module: r.targetModule || null,
            internal_attendees: r.internalAttendees || null, external_attendees: r.externalAttendees || null, detail: r.detail
        })),
        deleteRecord: async id => run(PM.sb.from('project_records').delete().eq('id', id)),
        updateRecord: async (id, r) => {
            const rows = await run(PM.sb.from('project_records').update({
                record_date: r.date, type: r.type, target_module: r.targetModule || null,
                internal_attendees: r.internalAttendees || null, external_attendees: r.externalAttendees || null, detail: r.detail
            }).eq('id', id).select('id'));
            if (!rows || !rows.length) throw new Error('只有撰寫人可以修改這筆紀錄（row-level security）');
        },
        // 分享：kind = 'project' | 'requirement'
        addShare: async (kind, id, email) => run(PM.sb.from(kind === 'project' ? 'project_shares' : 'requirement_shares')
            .insert({ [kind === 'project' ? 'project_id' : 'requirement_id']: id, email: String(email).trim().toLowerCase() })),
        removeShare: async (kind, id, email) => run(PM.sb.from(kind === 'project' ? 'project_shares' : 'requirement_shares')
            .delete().eq(kind === 'project' ? 'project_id' : 'requirement_id', id).eq('email', email)),

        // 新增用 insert、既有用 update（新資料寫入前不存在，無法用 upsert 通過「看得到才能寫」的權限檢查）
        saveRequirement: async r => {
            const row = { type: r.type, title: r.title, factory: r.factory, dept: r.dept, requester: r.user, status: r.status,
                created_date: r.createdDate || PM.today(), description: r.desc, target: r.target || null, linked_project_id: nz(r.linkedProjectId) };
            if (cache.reqs.some(x => x.id === r.id)) {
                const rows = await run(PM.sb.from('requirements').update(row).eq('id', r.id).select('id'));
                if (!rows || !rows.length) throw new Error('權限不足：只有擁有者能修改需求案件（row-level security）');
            } else await run(PM.sb.from('requirements').insert(Object.assign({ id: r.id || PM.newId() }, row)));
        },
        patchRequirement: async (id, patch) => {
            const map = { status: 'status', linkedProjectId: 'linked_project_id' };
            const row = {};
            Object.keys(patch).forEach(k => { if (map[k]) row[map[k]] = patch[k]; });
            return run(PM.sb.from('requirements').update(row).eq('id', id));
        },
        deleteRequirement: async id => run(PM.sb.from('requirements').delete().eq('id', id)),
        addDiscussion: async (reqId, d) => run(PM.sb.from('requirement_discussions').insert({
            requirement_id: reqId, disc_date: d.date, type: d.type, internal: d.internal || null, external: d.external || null, content: d.content
        })),
        deleteDiscussion: async id => run(PM.sb.from('requirement_discussions').delete().eq('id', id)),
        updateDiscussion: async (id, d) => {
            const rows = await run(PM.sb.from('requirement_discussions').update({
                disc_date: d.date, type: d.type, internal: d.internal || null, external: d.external || null, content: d.content
            }).eq('id', id).select('id'));
            if (!rows || !rows.length) throw new Error('只有撰寫人可以修改這筆紀錄（row-level security）');
        },

        savePerson: async u => run(PM.sb.from('people').upsert({
            id: u.id || PM.newId(), category: u.category, dept: u.dept, name: u.name, email: u.email || null, factory: u.factory, note: u.note || null
        })),
        deletePerson: async id => run(PM.sb.from('people').delete().eq('id', id)),

        saveDicts: async d => run(PM.sb.from('app_settings').upsert({ key: 'dicts', value: d })),
        // 變更字典名稱，並把既有資料中的舊名稱一併改成新名稱
        renameDictValue: async (key, oldV, newV) => {
            const d = PM.clone(cache.dicts);
            const i = d[key].indexOf(oldV);
            if (i < 0) throw new Error('找不到「' + oldV + '」');
            if (d[key].includes(newV)) throw new Error('「' + newV + '」已存在');
            d[key][i] = newV;
            const targets = {
                projTypes: [['projects', 'type'], ['requirements', 'type']],
                factories: [['projects', 'factory'], ['requirements', 'factory'], ['people', 'factory']],
                recordTypes: [['project_records', 'type'], ['requirement_discussions', 'type']]
            }[key] || [];
            for (const [t, c] of targets) await run(PM.sb.from(t).update({ [c]: newV }).eq(c, oldV));
            await run(PM.sb.from('app_settings').upsert({ key: 'dicts', value: d }));
        },
        saveSettings: async s => run(PM.sb.from('app_settings').upsert({ key: 'rules', value: s })),

        // 上傳照片：壓縮 → 存到 Storage → 更新專案 → 刪除舊檔
        uploadImage: async (pid, field, file) => {
            const blob = file instanceof Blob && file.type === 'image/jpeg' && file.size < 600 * 1024 ? file : await PM.compressImage(file);
            const path = `${pid}/${field}_${Date.now()}.jpg`;
            await run(PM.sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
            const key = field === 'before' ? 'imgBefore' : 'imgAfter';
            const old = (cache.projects.find(x => x.id === pid) || {})[key];
            await PM.api.patchProject(pid, { [key]: path });
            if (old && !isExternal(old)) await PM.sb.storage.from(BUCKET).remove([old]);
            return path;
        },

        // 成員管理（僅管理員）
        listMembers: async () => run(PM.sb.from('app_members').select('*').order('created_at')),
        saveMember: async m => run(PM.sb.from('app_members').upsert({ email: m.email.trim().toLowerCase(), role: m.role, display_name: m.display_name || null })),
        deleteMember: async email => run(PM.sb.from('app_members').delete().eq('email', email))
    };

    /* ---------- 執行寫入並重新讀取 ---------- */
    let busyEl = null;
    PM.setBusy = on => {
        if (on) {
            if (!busyEl) { busyEl = document.createElement('div'); busyEl.className = 'pm-overlay busy'; busyEl.innerHTML = '<div class="spinner"></div>'; }
            document.body.appendChild(busyEl);
        } else if (busyEl) busyEl.remove();
    };
    PM.errMsg = e => {
        const m = (e && (e.message || e.error_description)) || String(e);
        if (/只有撰寫人/.test(m)) return '只有撰寫人可以修改或刪除自己的追蹤紀錄';
        if (/project_shares_pkey|requirement_shares_pkey/.test(m)) return '已經分享給這位成員了';
        if (/row-level security|permission denied|violates row-level/i.test(m)) return '權限不足（只有擁有者能修改專案／需求本身；追蹤紀錄只有撰寫人能修改）';
        if (/people_email_uniq|duplicate key.*email/i.test(m)) return '此 Email 已存在於名冊中';
        if (/Failed to fetch|NetworkError/i.test(m)) return '無法連線到資料庫，請檢查網路';
        if (/JWT|session/i.test(m)) return '登入已逾時，請重新登入';
        return m;
    };
    PM.act = async (fn, okMsg) => {
        PM.setBusy(true);
        try {
            const r = await fn();
            await PM.reload();
            if (okMsg) PM.toast(okMsg);
            return (r === undefined || r === null) ? true : r;
        } catch (e) {
            console.error(e);
            PM.toast('操作失敗：' + PM.errMsg(e), true);
            try { await PM.reload(); } catch (_) {}
            return false;
        } finally { PM.setBusy(false); }
    };

    /* =================== 進度計算 =================== */
    PM.calcModuleProgress = m => {
        const subs = m.subtasks || [];
        return subs.length ? Math.round(subs.reduce((s, x) => s + (Number(x.progress) || 0), 0) / subs.length) : 0;
    };
    PM.calcProjectProgress = p => {
        const all = (p.modules || []).flatMap(m => m.subtasks || []);
        return all.length ? Math.round(all.reduce((s, x) => s + (Number(x.progress) || 0), 0) / all.length) : 0;
    };
    PM.moduleRange = m => {
        const subs = (m.subtasks || []).filter(s => PM.parseDate(s.start) && PM.parseDate(s.end));
        if (!subs.length) return null;
        return { start: subs.map(s => s.start).sort()[0], end: subs.map(s => s.end).sort().pop() };
    };
    PM.isDelayed = (task, settings) => {
        settings = settings || cache.settings;
        const prog = Number(task.progress) || 0;
        if (prog >= 100) return false;
        const s = PM.parseDate(task.start), e = PM.parseDate(task.end), now = PM.parseDate(PM.today());
        if (!s || !e || now <= s) return false;
        if (now > e) return true;
        const dur = Math.max(1, (e - s) / 864e5);
        const expected = ((now - s) / 864e5) / dur * 100;
        return (expected - prog) / 100 * dur > settings.delayDays;
    };
    PM.lastRecordDate = p => (p.records || []).map(r => r.date).filter(Boolean).sort().pop() || null;
    PM.staleDays = p => {
        if (p.status !== '進行中') return 0;
        const last = PM.lastRecordDate(p) || p.start;
        if (!last) return 0;
        const d = PM.daysBetween(last, PM.today());
        return d > cache.settings.staleDays ? d : 0;
    };

    /* =================== 樣式對應 =================== */
    PM.typeClass = t => ({ 'AMR搬運': 'type-amr', '手臂': 'type-arm', '系統': 'type-sys', '設備改造': 'type-mod', '影像辨識': 'type-ai' }[t] || 'type-other');
    PM.statusClass = s => ({ '進行中': 'st-ing', '評估中': 'st-plan', '專案完成': 'st-done', '專案終止': 'st-stop',
        '需求討論中': 'st-plan', '現場場勘評估': 'st-ing', '方案確認成案': 'st-done', '已轉專案': 'st-req', '暫緩／不成案': 'st-stop' }[s] || 'st-stop');
    PM.statusBadge = s => `<span class="badge ${PM.statusClass(s)}">${PM.esc(s)}</span>`;
    PM.typeTag = t => `<span class="proj-type-tag ${PM.typeClass(t)}">${PM.esc(t)}</span>`;
    PM.recClass = t => ({ '當面會議': 'rec-meeting', '線上會議': 'rec-meeting', '現場場勘': 'rec-site', '資料審查整理': 'rec-review', '方案討論變動': 'rec-change', '異常狀況': 'rec-issue' }[t] || 'rec-other');
    PM.recTag = t => `<span class="rec-tag ${PM.recClass(t)}">${PM.esc(t)}</span>`;

    /* =================== DOM 工具 =================== */
    PM.fillSelect = (sel, items, value, placeholder) => {
        if (typeof sel === 'string') sel = document.getElementById(sel);
        if (!sel) return;
        const list = items.slice();
        if (value && !list.includes(value)) list.push(value);
        sel.innerHTML = (placeholder ? `<option value="">${PM.esc(placeholder)}</option>` : '') +
            list.map(v => `<option value="${PM.esc(v)}">${PM.esc(v)}</option>`).join('');
        if (value !== undefined && value !== null) sel.value = value;
    };
    PM.injectPeopleDatalist = (id = 'peopleList') => {
        let dl = document.getElementById(id);
        if (!dl) { dl = document.createElement('datalist'); dl.id = id; document.body.appendChild(dl); }
        dl.innerHTML = cache.people.map(u => `<option value="${PM.esc(u.name)}">${PM.esc(u.dept)}</option>`).join('');
    };
    /* ---------- 多選下拉（與會人員用） ----------
       用法：PM.attendeeSelect('元素id', '內部單位' | '外部廠商')
       元素的 .value 會回傳「A (單位), B (單位)」字串，可直接存入資料庫；設 .value = '' 可清空 */
    PM.multiSelect = (el, opts = {}) => {
        if (typeof el === 'string') el = document.getElementById(el);
        if (!el._ms) {
            const st = el._ms = { options: [], selected: [], open: false, q: '' };
            el.classList.add('ms');
            el.innerHTML = `<div class="ms-box" tabindex="0"><div class="ms-chips"></div><span class="ms-caret">▾</span></div>
                <div class="ms-panel"><input type="text" class="ms-search" placeholder="搜尋或輸入名冊外的人員後按 Enter…"><div class="ms-list"></div></div>`;
            const box = el.querySelector('.ms-box'), search = el.querySelector('.ms-search');
            const toggleOpen = force => { st.open = force ?? !st.open; el.classList.toggle('open', st.open); if (st.open) { search.value = st.q = ''; renderList(); search.focus(); } };
            box.addEventListener('click', e => { if (e.target.closest('.ms-chip-x')) return; toggleOpen(); });
            box.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); toggleOpen(true); } });
            search.addEventListener('input', () => { st.q = search.value.trim(); renderList(); });
            search.addEventListener('keydown', e => {
                if (e.key === 'Escape') { e.stopPropagation(); toggleOpen(false); box.focus(); }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const hits = filtered();
                    if (hits.length === 1) toggleVal(hits[0].value);
                    else if (st.q && !hits.some(o => o.value === st.q)) addCustom(st.q);
                    search.value = st.q = ''; renderList();
                }
            });
            document.addEventListener('click', e => { if (st.open && !el.contains(e.target)) toggleOpen(false); });
            const filtered = () => { const q = st.q.toLowerCase(); return st.options.filter(o => !q || [o.value, o.label, o.sub, o.group].join(' ').toLowerCase().includes(q)); };
            const toggleVal = v => { st.selected = st.selected.includes(v) ? st.selected.filter(x => x !== v) : [...st.selected, v]; renderChips(); };
            const addCustom = v => { if (!st.selected.includes(v)) st.selected.push(v); renderChips(); };
            function renderChips() {
                const c = el.querySelector('.ms-chips');
                c.innerHTML = st.selected.length ? st.selected.map(v => `<span class="ms-chip">${PM.esc(v)}<button type="button" class="ms-chip-x" data-v="${PM.esc(v)}" title="移除">×</button></span>`).join('')
                    : `<span class="ms-placeholder">${PM.esc(opts.placeholder || '點此選擇（可複選）')}</span>`;
                c.querySelectorAll('.ms-chip-x').forEach(b => b.onclick = e => { e.stopPropagation(); toggleVal(b.dataset.v); if (st.open) renderList(); });
                if (st.open) renderList();
            }
            function renderList() {
                const list = el.querySelector('.ms-list');
                const hits = filtered();
                let groups = {};
                hits.forEach(o => { (groups[o.group || ''] = groups[o.group || ''] || []).push(o); });
                let html = Object.keys(groups).map(g => (g ? `<div class="ms-group">${PM.esc(g)}</div>` : '') + groups[g].map(o => `
                    <label class="ms-opt"><input type="checkbox" data-v="${PM.esc(o.value)}" ${st.selected.includes(o.value) ? 'checked' : ''}>
                        <span>${PM.esc(o.label)}</span>${o.sub ? `<small>${PM.esc(o.sub)}</small>` : ''}</label>`).join('')).join('');
                const custom = st.selected.filter(v => !st.options.some(o => o.value === v));
                if (custom.length) html += `<div class="ms-group">名冊外人員</div>` + custom.map(v => `<label class="ms-opt"><input type="checkbox" data-v="${PM.esc(v)}" checked><span>${PM.esc(v)}</span></label>`).join('');
                if (st.q && !st.options.some(o => o.value === st.q) && !st.selected.includes(st.q)) html += `<button type="button" class="ms-add">＋ 加入「${PM.esc(st.q)}」</button>`;
                if (!html) html = `<div class="ms-empty">${st.options.length ? '找不到符合的人員' : '名冊中尚無人員，可直接輸入後按 Enter 加入'}</div>`;
                list.innerHTML = html;
                list.querySelectorAll('input[data-v]').forEach(i => i.onchange = () => toggleVal(i.dataset.v));
                const add = list.querySelector('.ms-add');
                if (add) add.onclick = () => { addCustom(st.q); search.value = st.q = ''; renderList(); search.focus(); };
            }
            st.renderChips = renderChips;
            Object.defineProperty(el, 'value', {
                configurable: true,
                get: () => st.selected.join(', '),
                set: v => { st.selected = String(v || '').split(/\s*[,，、]\s*/).filter(Boolean); renderChips(); }
            });
            renderChips();
        }
        if (opts.options) { el._ms.options = opts.options; el._ms.renderChips(); }
        return el;
    };
    PM.attendeeSelect = (el, category) => {
        const people = cache.people.filter(u => u.category === category)
            .sort((a, b) => (a.dept || '').localeCompare(b.dept || '', 'zh-Hant') || a.name.localeCompare(b.name, 'zh-Hant'));
        return PM.multiSelect(el, {
            placeholder: category === '外部廠商' ? '點此選擇廠商人員（可複選）' : '點此選擇內部人員（可複選）',
            options: people.map(u => ({ value: `${u.name} (${u.dept})`, label: u.name, sub: category === '外部廠商' ? '' : (u.factory || ''), group: u.dept }))
        });
    };

    /* ---------- 分享視窗 ---------- */
    PM.shareDialog = (kind, id, onDone) => {
        const item = kind === 'project' ? PM.getProject(id) : PM.getRequirements().find(r => r.id === id);
        if (!item) return;
        if (!PM.isOwner(item)) { alert('只有擁有者可以設定分享。'); return; }
        let el = document.getElementById('shareModal');
        if (!el) {
            el = document.createElement('div');
            el.className = 'modal-overlay';
            el.id = 'shareModal';
            el.innerHTML = '<div class="modal-box" style="width:520px"><div class="modal-title" id="shareTitle"></div><div id="shareBody"></div></div>';
            document.body.appendChild(el);
        }
        const render = () => {
            const cur = kind === 'project' ? PM.getProject(id) : PM.getRequirements().find(r => r.id === id);
            const me = PM.user.email.toLowerCase();
            const candidates = cache.members.filter(m => m.email !== me && !cur.shares.includes(m.email));
            el.querySelector('#shareTitle').textContent = `🔗 分享${kind === 'project' ? '專案' : '需求案件'}：${cur.name || cur.title}`;
            el.querySelector('#shareBody').innerHTML = `
                <div class="share-note">被分享的成員可以<b>查看</b>此${kind === 'project' ? '專案（含甘特圖、細項、照片）' : '需求案件'}並<b>新增追蹤紀錄</b>，
                    但不能修改${kind === 'project' ? '專案內容、細項或進度' : '需求內容與狀態'}。每筆追蹤紀錄只有撰寫人能修改。</div>
                <div class="share-add">
                    <select id="shareSelect" class="filter-select" style="flex:1">
                        <option value="">選擇成員…</option>
                        ${candidates.map(m => `<option value="${PM.esc(m.email)}">${PM.esc(m.name || m.email.split('@')[0])}（${PM.esc(m.email)}）</option>`).join('')}
                    </select>
                    <button type="button" class="btn btn-primary" id="shareAddBtn">＋ 分享</button>
                </div>
                ${candidates.length ? '' : '<div class="muted" style="margin-top:6px">成員名單中已沒有可分享的人。新同事需先由管理員加入「系統設定 → 成員與權限」。</div>'}
                <div class="share-list-title">目前分享給（${cur.shares.length} 人）</div>
                <div class="share-list">${cur.shares.length ? cur.shares.map(e => `
                    <div class="share-row"><span>👤 <b>${PM.esc(PM.memberName(e))}</b> <span class="muted">${PM.esc(e)}</span></span>
                        <button type="button" class="btn-action del" data-email="${PM.esc(e)}">取消分享</button></div>`).join('')
                    : '<div class="muted" style="padding:10px 0">尚未分享給任何人，目前只有你（與管理員）看得到。</div>'}</div>
                <div class="modal-actions"><button type="button" class="btn btn-secondary" id="shareClose">完成</button></div>`;
            el.querySelector('#shareAddBtn').onclick = async () => {
                const email = el.querySelector('#shareSelect').value;
                if (!email) { alert('請先選擇要分享的成員'); return; }
                if (await PM.act(() => PM.api.addShare(kind, id, email), `已分享給 ${PM.memberName(email)}`)) { render(); if (onDone) onDone(); }
            };
            el.querySelectorAll('[data-email]').forEach(b => b.onclick = async () => {
                if (!confirm(`取消分享給 ${PM.memberName(b.dataset.email)}？對方將無法再看到此${kind === 'project' ? '專案' : '需求'}（對方已寫的追蹤紀錄會保留）。`)) return;
                if (await PM.act(() => PM.api.removeShare(kind, id, b.dataset.email), '已取消分享')) { render(); if (onDone) onDone(); }
            });
            el.querySelector('#shareClose').onclick = () => PM.closeModal('shareModal');
        };
        render();
        PM.openModal('shareModal');
    };

    PM.toast = (msg, isError) => {
        let el = document.getElementById('pmToast');
        if (!el) { el = document.createElement('div'); el.id = 'pmToast'; el.className = 'toast'; document.body.appendChild(el); }
        el.textContent = msg;
        el.classList.toggle('error', !!isError);
        el.classList.add('show');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2200);
    };
    PM.openModal = id => document.getElementById(id).classList.add('open');
    PM.closeModal = id => document.getElementById(id).classList.remove('open');

    PM.csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    PM.downloadCSV = (header, rows, fileName) => {
        const csv = '﻿' + [header, ...rows].map(r => r.map(PM.csvCell).join(',')).join('\r\n');
        PM.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), fileName);
    };
    PM.downloadBlob = (blob, fileName) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName.replace(/[\\/:*?"<>|]/g, '_');
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };

    // 圖片壓縮成 JPEG Blob（最長邊 1280px）
    PM.compressImage = (file, maxW = 1280, quality = 0.8) => new Promise((resolve, reject) => {
        const url = typeof file === 'string' ? file : URL.createObjectURL(file);
        const img = new Image();
        const timer = setTimeout(() => reject(new Error('圖片讀取逾時')), 15000);
        img.onerror = () => { clearTimeout(timer); reject(new Error('圖片讀取失敗')); };
        img.onload = () => {
            clearTimeout(timer);
            const scale = Math.min(1, maxW / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * scale);
            c.height = Math.round(img.height * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            c.toBlob(b => b ? resolve(b) : reject(new Error('圖片壓縮失敗')), 'image/jpeg', quality);
            if (typeof file !== 'string') URL.revokeObjectURL(url);
        };
        img.src = url;
    });

    /* =================== 匯入 / 匯出 =================== */
    // 匯出成與 v2.x 備份相同的 JSON 結構（可再匯入）
    PM.exportData = () => ({
        system: '專案管理系統', version: PM.VERSION, exportDate: new Date().toISOString(),
        pm_projects_list: cache.projects.map(p => { const c = PM.clone(p); delete c.imgBeforeUrl; delete c.imgAfterUrl; return c; }),
        pm_requirements_list: PM.clone(cache.reqs),
        pm_users_list: PM.clone(cache.people),
        pm_system_dicts: PM.clone(cache.dicts),
        pm_system_settings: { ...cache.settings }
    });

    // 匯入 v2.x（瀏覽器版）備份檔或 v3 匯出檔。UUID 相同的資料會覆蓋更新，不會重複。
    PM.importData = async (data, log = () => {}) => {
        const projects = Array.isArray(data.pm_projects_list) ? data.pm_projects_list : [];
        const reqs = Array.isArray(data.pm_requirements_list) ? data.pm_requirements_list : [];
        const people = Array.isArray(data.pm_users_list) ? data.pm_users_list : [];
        const idMap = {};
        const mapId = old => { if (!old) return null; if (!idMap[old]) idMap[old] = PM.isUuid(old) ? old : PM.newId(); return idMap[old]; };
        const stat = { projects: 0, records: 0, reqs: 0, discussions: 0, people: 0, images: 0, skipped: 0 };

        if (data.pm_system_dicts) {
            const d = PM.clone(cache.dicts);
            ['projTypes', 'factories', 'recordTypes'].forEach(k => (data.pm_system_dicts[k] || []).forEach(v => { if (!d[k].includes(v)) d[k].push(v); }));
            await PM.api.saveDicts(d);
        }
        if (data.pm_system_settings) await PM.api.saveSettings(Object.assign({}, PM.DEFAULT_SETTINGS, data.pm_system_settings));

        const existingEmails = new Set(cache.people.map(u => (u.email || '').toLowerCase()).filter(Boolean));
        const rows = [];
        people.forEach(u => {
            const email = (u.email || '').trim().toLowerCase();
            const id = mapId(u.id) || PM.newId();
            if (email && existingEmails.has(email) && !cache.people.some(x => x.id === id)) { stat.skipped++; return; }
            if (email) existingEmails.add(email);
            const category = u.category === '外部廠商' ? '外部廠商' : '內部單位';
            rows.push({ id, category, dept: u.dept || '-', name: u.name || '-', email: email || null, factory: category === '外部廠商' ? null : (u.factory || null), note: u.note || null });
        });
        if (rows.length) { await run(PM.sb.from('people').upsert(rows)); stat.people = rows.length; }
        log(`人員名冊：${stat.people} 筆`);

        for (const p of projects) {
            const pid = mapId(p.id) || PM.newId();
            const modules = (p.modules || []).map(m => ({ id: mapId(m.id || PM.newId()), name: m.name || '未命名模塊', owner: m.owner || '',
                subtasks: (m.subtasks || []).map(t => Object.assign({}, t, { id: t.id ? mapId(t.id) : null })) }));
            const status = PM.PROJECT_STATUSES.includes(p.status) ? p.status : '進行中';
            let start = p.start || null, end = p.end || null;
            if (start && end && end < start) end = start;
            const imgs = {};
            for (const f of ['imgBefore', 'imgAfter']) {
                const v = p[f] || '';
                if (/^https?:/.test(v)) imgs[f] = v;
                else if (/^data:/.test(v)) imgs[f] = { dataUrl: v };
                else if (v) imgs[f] = v;   // v3 Storage 路徑
            }
            await PM.api.saveProject({
                id: pid, name: p.name || '未命名專案', type: p.type || '', factory: p.factory || '', status, start, end,
                owner: p.owner || '', pm: p.pm || '', descBefore: p.descBefore || '', descAfter: p.descAfter || '',
                imgBefore: typeof imgs.imgBefore === 'string' ? imgs.imgBefore : null,
                imgAfter: typeof imgs.imgAfter === 'string' ? imgs.imgAfter : null,
                hiddenModules: (p.hiddenModules || []).map(h => idMap[h]).filter(Boolean),
                hiddenTasks: (p.hiddenTasks || []).map(h => idMap[h]).filter(Boolean),
                sourceRequirementId: null, modules
            });
            for (const f of ['imgBefore', 'imgAfter']) {
                if (imgs[f] && imgs[f].dataUrl) {
                    try {
                        const blob = await PM.compressImage(imgs[f].dataUrl);
                        await PM.api.uploadImage(pid, f === 'imgBefore' ? 'before' : 'after', blob);
                        stat.images++;
                    } catch (e) { console.warn('照片匯入失敗', e); }
                }
            }
            const recs = (p.records || []).filter(r => r.detail && r.date).map(r => ({
                id: PM.isUuid(r.id) ? r.id : PM.newId(), project_id: pid, record_date: r.date, type: r.type || '系統紀錄',
                target_module: r.targetModule || null, internal_attendees: r.internalAttendees || null,
                external_attendees: r.externalAttendees || null, detail: r.detail
            }));
            // 已存在的紀錄（重複匯入同一份備份）略過，避免改動別人寫的紀錄
            const haveR = new Set(cache.projects.flatMap(x => x.records.map(r => r.id)));
            const newRecs = recs.filter(r => !haveR.has(r.id));
            if (newRecs.length) await run(PM.sb.from('project_records').insert(newRecs));
            stat.projects++; stat.records += recs.length;
            log(`專案：${p.name}（${recs.length} 筆履歷）`);
        }

        for (const r of reqs) {
            const rid = mapId(r.id) || PM.newId();
            const status = PM.REQ_STATUSES.includes(r.status) ? r.status : '需求討論中';
            const linked = r.linkedProjectId ? (idMap[r.linkedProjectId] || (PM.isUuid(r.linkedProjectId) ? r.linkedProjectId : null)) : null;
            await PM.api.saveRequirement({
                id: rid, type: r.type || PM.DEFAULT_DICTS.projTypes[0], title: r.title || '未命名需求', factory: r.factory || '', dept: r.dept || '',
                user: r.user || '', status, createdDate: r.createdDate || PM.today(), desc: r.desc || '', target: r.target || '', linkedProjectId: linked
            });
            const ds = (r.discussions || []).filter(d => d.content && d.date).map(d => ({
                id: PM.isUuid(d.id) ? d.id : PM.newId(), requirement_id: rid, disc_date: d.date, type: d.type || '當面會議',
                internal: d.internal || null, external: d.external || null, content: d.content
            }));
            const haveD = new Set(cache.reqs.flatMap(x => x.discussions.map(d => d.id)));
            const newDs = ds.filter(d => !haveD.has(d.id));
            if (newDs.length) await run(PM.sb.from('requirement_discussions').insert(newDs));
            stat.reqs++; stat.discussions += ds.length;
        }
        log(`需求評估：${stat.reqs} 件（${stat.discussions} 則討論）`);
        return stat;
    };

    /* =================== 示範資料（供「匯入示範資料」使用） =================== */
    const t = (name, pm, owner, start, end, progress) => ({ name, pm, owner, start, end, progress });
    PM.DEMO_DATA = {
        pm_projects_list: [{
            id: 'demo_proj_agv', name: '東莞台威 AGV＋WMS 三期專案', type: 'AMR搬運', factory: '東莞廠', status: '進行中',
            start: '2026-11-01', end: '2027-05-31', owner: '待指定（專案處主管）', pm: 'Sam, Wayne, IT',
            descBefore: '人工搬運 5 條組底線與 4 條成型線領料，單趟耗時 10 分鐘且多 SKU 找料困難',
            descAfter: '摩爾 WMS 串聯仙工 CTU 料箱機器人＋1,428 貨位立體庫與中力戶外地牛',
            hiddenModules: ['dm5', 'dm6', 'dm7', 'dm8'],
            modules: [
                { id: 'dm1', name: '一、硬體到貨與配置', owner: '總工務主管', subtasks: [
                    t('1. 全部設備到貨驗收', 'Sam', '倉庫主管', '2027-01-14', '2027-01-28', 0),
                    t('2. 塔式伺服器 DELL T550', 'IT', 'IT主管', '2026-11-10', '2026-11-20', 100),
                    t('3. 貨架 1,428 貨位安裝', 'Sam', '倉庫主管', '2027-01-10', '2027-01-31', 10)] },
                { id: 'dm2', name: '二、AGV／AMR 運行', owner: '總工務主管', subtasks: [
                    t('4. 料箱機器人 SPK-M6107-ZQ', 'Sam', '倉庫主管', '2027-01-14', '2027-03-10', 25),
                    t('5. 室外地牛 ARL-H-20', 'Wayne', '總工務主管', '2027-04-01', '2027-05-10', 0)] },
                { id: 'dm3', name: '三、倉儲與配套設施', owner: '倉庫主管', subtasks: [t('8. 對接工作台', 'Sam', '倉庫主管', '2027-01-14', '2027-03-01', 10)] },
                { id: 'dm4', name: '四、WMS 軟體功能', owner: '底加工／倉庫主管', subtasks: [
                    t('12. 基礎倉儲資訊管理', 'Wayne', '倉庫主管', '2026-11-10', '2026-12-20', 100),
                    t('13. 入庫與出庫流程對接', 'Wayne', '倉庫主管', '2026-12-01', '2027-02-28', 50)] },
                { id: 'dm5', name: '五、ERP 介面', owner: 'IT 主管', subtasks: [t('ERP 源頭單據讀取／寫入介面', 'IT', 'IT主管', '2026-11-15', '2027-02-15', 50)] },
                { id: 'dm6', name: '六、系統整合聯動', owner: 'IT 主管', subtasks: [t('WMS × 機器人調度 × ERP 聯動測試', 'Wayne', 'IT主管', '2027-01-20', '2027-03-31', 10)] },
                { id: 'dm7', name: '七、實施交付與培訓', owner: '底加工／倉庫主管', subtasks: [t('操作人員培訓與上線陪跑', 'Sam', '倉庫主管', '2027-03-01', '2027-04-30', 0)] },
                { id: 'dm8', name: '八、整體驗收與付款', owner: '專案 Owner', subtasks: [t('終驗收與尾款支付', 'Sam, Wayne', '專案 Owner', '2027-05-01', '2027-05-31', 0)] }
            ],
            records: [
                { date: '2027-01-14', targetModule: '二、AGV／AMR 運行', type: '現場場勘', internalAttendees: 'Sam (倉庫主管)', externalAttendees: '仙工智能交車員', detail: '首台仙工料箱機器人（CTU）與充電樁到貨，進入外觀清點與雷達／相機通電測試。' },
                { date: '2027-01-10', targetModule: '一、硬體到貨與配置', type: '現場場勘', internalAttendees: 'Sam', externalAttendees: '東莞台威實施隊', detail: '倉庫 1,428 貨位鋼構材料進場，施工隊伍展開 10 天組裝工程與二維碼標籤定位。' },
                { date: '2026-12-30', targetModule: '四、WMS 軟體功能', type: '資料審查整理', internalAttendees: 'Wayne, IT', externalAttendees: '摩爾 WMS 顧問', detail: 'WMS 基礎資料庫與 ERP 採購、委外等源頭單據讀取介面完成第一階段數據聯調。' },
                { date: '2026-12-15', targetModule: '二、AGV／AMR 運行', type: '方案討論變動', internalAttendees: 'Sam, Wayne', externalAttendees: '東莞台威經理', detail: '成型線戶外配送評估需 3 台地牛，已提出追加簽呈評估，預計 2/1 前定案第三期下單。' },
                { date: '2026-11-20', targetModule: '一、硬體到貨與配置', type: '現場場勘', internalAttendees: 'IT, Sam', externalAttendees: '東莞台威工程師', detail: 'DELL T550 伺服器完成上架與系統配置，車間 AP 無線工業網路覆蓋測試全數達標。' }
            ]
        }],
        pm_requirements_list: [
            { id: 'demo_req1', type: 'AMR搬運', title: '東莞廠成型線戶外地牛配送台數評估', factory: '東莞廠', dept: '總工務處 / 底加工倉庫', user: 'Sam (底加工主管)', status: '需求討論中', createdDate: '2026-10-15',
              desc: '依需求白皮書估算戶外成型線領料單趟耗時 10 分鐘，配送需 3 台地牛才能維持不缺料；但原供應商報價僅列 1 台，需在第三期下單前定案台數與雨棚動線。',
              target: '避免成型線斷料，達成戶外滿載 1,500 kg 穩定自動搬運。',
              discussions: [{ date: '2026-12-15', type: '方案討論變動', internal: 'Sam, Wayne', external: '東莞台威李經理', content: '檢討 1 台 vs 3 台地牛節拍，決議追加 2 台評估簽呈並於 2/1 前正式定案。' },
                            { date: '2026-11-20', type: '現場場勘', internal: 'Sam, 工務主管', external: '中力搬運黃工程師', content: '實測室外柏油路面承重與坡度，確認雨棚覆蓋範圍與地牛防雨防滑等級。' }] },
            { id: 'demo_req2', type: '系統', title: 'WMS 與 ERP 雙向即時庫存及單據對接評估', factory: '東莞廠', dept: 'IT資訊部 / 底加工', user: 'Wayne & IT主管', status: '方案確認成案', createdDate: '2026-10-20',
              desc: 'WMS 出入庫單需自動生成並即時同步回 ERP，包含採購、返修、委外等源頭單據全覆蓋，目前寫入介面工作量與報價待明確。',
              target: '取消人工二次過帳，即時庫存準確率提升至 99.9%。',
              discussions: [{ date: '2026-11-05', type: '線上會議', internal: 'IT主管, Wayne', external: '摩爾軟體陳顧問', content: '確認讀取接口 30 天工期，寫入接口工作量待藍圖調研後定案。' }] },
            { id: 'demo_req3', type: '手臂', title: '成型課自動出模取件與修邊機械手臂需求', factory: '越南一廠', dept: '成型二課', user: '阮課長', status: '現場場勘評估', createdDate: '2026-11-10',
              desc: '大底出模高溫作業環境人員流動大，需評估 6 軸工業手臂搭配夾爪進行高溫取件與初級修邊。', target: '取代高溫作業人工 2 班共 4 人，循環節拍控制在 45 秒內。',
              discussions: [{ date: '2026-12-02', type: '當面會議', internal: '成型課長, 越南工務', external: '手臂自動化廠商窗口', content: '現場量測模機行程與安全防護光柵距離，確認手臂負載需 20kg 以上。' }] },
            { id: 'demo_req4', type: '影像辨識', title: '大底成型後端色差與氣泡 AI 視覺自動檢測', factory: '東莞廠', dept: '品保處', user: '張工程師', status: '需求討論中', createdDate: '2026-12-05',
              desc: '目前靠品檢員肉眼抽檢，多顏色 SKU 易發生色差漏檢，評估輸送線上架設工業相機與邊緣運算模型。', target: '檢驗漏檢率降低至 0.1% 以下，每雙鞋底檢測時間低於 1.5 秒。',
              discussions: [{ date: '2027-01-08', type: '線上會議', internal: '品保主管, IT處', external: '視覺演算法協力廠', content: '提供 500 張實拍瑕疵樣本進行模型可行性驗證 (POC)。' }] }
        ],
        pm_users_list: [
            { category: '內部單位', dept: '底加工／倉庫主管', name: 'Sam', email: 'sam@company.com', factory: '東莞廠', note: '負責倉儲業務動線與現場到貨驗收' },
            { category: '內部單位', dept: '第三軸自動化', name: 'Wayne', email: 'wayne@company.com', factory: '東莞廠', note: '負責系統排程、廠商介接對接' },
            { category: '內部單位', dept: 'IT資訊部', name: 'IT主管', email: 'it@company.com', factory: '東莞廠', note: '負責 ERP 介面與車間 AP 網絡通訊' },
            { category: '外部廠商', dept: '仙工智能', name: '周經理', email: 'zhou@seer-group.com', note: 'CTU 料箱機器人原廠技術窗口' },
            { category: '外部廠商', dept: '摩爾軟體', name: '陳顧問', email: 'chen@more-soft.com', note: 'WMS 系統套件與 ERP 接口架構師' },
            { category: '外部廠商', dept: '中力搬運', name: '黃工程師', email: 'huang@ep-equipment.com', note: '室外地牛與充電樁設備對接窗口' }
        ]
    };

    /* =================== 側邊欄 =================== */
    PM.MENU = [
        { key: 'index', href: 'index.html', icon: '📊', text: '專案管理項目' },
        { key: 'project_list', href: 'project_list.html', icon: '📋', text: '專案管理項目列表' },
        { key: 'requirements', href: 'requirements.html', icon: '📝', text: '項目需求評估' },
        { key: 'users_dept', href: 'users_dept.html', icon: '👥', text: '人員與單位管理' },
        { key: 'factory_mgmt', href: 'factory_mgmt.html', icon: '🏭', text: '廠區管理' },
        { key: 'settings', href: 'settings.html', icon: '⚙️', text: '系統設定與報表' }
    ];
    PM.renderSidebar = active => {
        const el = document.getElementById('sidebar');
        if (!el) return;
        let collapsed = false;
        try { collapsed = localStorage.getItem('pm_sidebar_collapsed') === '1'; } catch (e) {}
        if (window.innerWidth < 900) collapsed = true;
        el.classList.toggle('collapsed', collapsed);
        const email = PM.user ? PM.user.email : '';
        el.innerHTML = `
            <div class="sidebar-header">
                <div class="brand-title">⚙️ 專案管理系統</div>
                <button class="btn-toggle-sidebar" type="button" title="收合 / 展開選單" onclick="PM.toggleSidebar()">☰</button>
            </div>
            <ul class="sidebar-menu">
                ${PM.MENU.map(m => `<li><a href="${m.href}" class="menu-item ${m.key === active ? 'active' : ''}" title="${m.text}">
                    <span class="menu-icon">${m.icon}</span><span class="menu-text">${m.text}</span></a></li>`).join('')}
            </ul>
            <div class="sidebar-footer">
                <div class="sidebar-user" title="${PM.esc(email)}">👤 ${PM.esc(email)}<span class="role">${PM.ROLE_NAMES[PM.role] || ''}</span></div>
                <div>版本：${PM.VERSION}｜${PM.offline ? '<b style="color:#f6ad55">離線測試模式</b>' : '雲端資料庫'}</div>
                ${PM.offline ? `<div class="offline-switch"><label>🧪 切換測試身分</label>
                        <select onchange="PM.switchOfflineUser(this.value)">${window.PMOffline.users.map(u => `<option value="${u.email}" ${u.email === email ? 'selected' : ''}>${PM.esc(u.name)}</option>`).join('')}</select></div>
                        <button class="btn-logout" type="button" onclick="PM.resetOffline()">重置測試資料</button>`
                             : '<button class="btn-logout" type="button" onclick="PM.logout()">登出</button>'}
            </div>`;
    };
    // 側邊欄收合狀態屬於個人介面偏好，仍記在瀏覽器（不影響資料）
    PM.toggleSidebar = () => {
        const el = document.getElementById('sidebar');
        el.classList.toggle('collapsed');
        try { localStorage.setItem('pm_sidebar_collapsed', el.classList.contains('collapsed') ? '1' : '0'); } catch (e) {}
    };

    /* =================== 登入 / 啟動 =================== */
    let overlay = null;
    function showOverlay(html) {
        if (!overlay) { overlay = document.createElement('div'); overlay.className = 'pm-overlay'; document.body.appendChild(overlay); }
        overlay.innerHTML = html;
    }
    function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
    PM.showError = (title, bodyHtml) => showOverlay(`<div class="err-box"><h3>${title}</h3>${bodyHtml}</div>`);

    PM.switchOfflineUser = email => { window.PMOffline.setUser(email); location.reload(); };

    // 離線示範資料：Sam 的專案分享給 Wayne；Wayne 另有自己的專案；王經理（管理員）可看全部
    async function seedOfflineDemo() {
        const O = window.PMOffline, back = PM.user;
        const as = async email => { O.setUser(email, false); const u = O.current(); PM.user = { id: u.id, email: u.email }; await PM.reload(); };
        await as('sam@local');
        await PM.importData(PM.clone(PM.DEMO_DATA));
        await PM.reload();
        const samProj = cache.projects.find(p => p.isMine);
        const samReq = cache.reqs.find(r => /地牛/.test(r.title));
        if (samProj) await PM.api.addShare('project', samProj.id, 'wayne@local');
        if (samReq) await PM.api.addShare('requirement', samReq.id, 'wayne@local');
        await as('wayne@local');
        const wid = PM.newId();
        await PM.api.saveProject({ id: wid, name: 'Wayne：越南一廠成型課手臂導入', type: '手臂', factory: '越南一廠', status: '評估中',
            start: '2026-12-01', end: '2027-04-30', owner: '廠長', pm: 'Wayne', hiddenModules: [],
            modules: [{ id: PM.newId(), name: '一、方案評估', owner: 'Wayne', subtasks: [
                { name: '1. 現場量測與節拍分析', pm: 'Wayne', owner: '廠長', start: '2026-12-01', end: '2026-12-20', progress: 30 },
                { name: '2. 廠商報價比較', pm: 'Wayne', owner: '廠長', start: '2026-12-15', end: '2027-01-15', progress: 0 }] }] });
        await PM.api.addRecord(wid, { date: '2026-12-02', type: '現場場勘', targetModule: '一、方案評估', internalAttendees: 'Wayne (第三軸自動化)', detail: '量測模機行程，初步確認手臂負載需 20kg 以上。' });
        if (samProj) await PM.api.addRecord(samProj.id, { date: '2027-01-15', type: '線上會議', targetModule: '二、AGV／AMR 運行',
            internalAttendees: 'Wayne (第三軸自動化)', detail: '（Wayne 新增的追蹤）已與仙工確認第二批 CTU 到貨時程，下週安排現場聯調。' });
        if (samReq) await PM.api.addDiscussion(samReq.id, { date: '2027-01-10', type: '線上會議', internal: 'Wayne (第三軸自動化)', content: '（Wayne 新增的討論）建議地牛追加至 2 台並保留第 3 台選配。' });
        O.setUser(back.email, false);
        PM.user = back;
    }

    PM.resetOffline = () => {
        if (!PM.offline) return;
        if (!confirm('清除本機所有測試資料並重新載入示範資料？')) return;
        window.PMOffline.reset();
        location.reload();
    };

    PM.logout = async () => {
        if (PM.sb) await PM.sb.auth.signOut();
        location.replace('login.html');
    };

    PM.boot = async (active, main) => {
        showOverlay('<div class="spinner"></div><div class="pm-overlay-text">資料載入中…</div>');
        if (!PM.configured || !PM.sb) {
            PM.showError('尚未設定資料庫連線', `請編輯 <code>assets/config.js</code>，把 <code>OFFLINE</code> 設為 <code>false</code> 並填入 Supabase 的 <b>Project URL</b> 與 <b>Publishable key</b>（<code>sb_publishable_</code> 開頭）。<br>詳細步驟請見專案根目錄的 <code>README.md</code>。`);
            return;
        }
        try {
            const { data: { session } } = await PM.sb.auth.getSession();
            if (!session) {
                const here = location.pathname.split('/').pop() + location.search + location.hash;
                location.replace('login.html?next=' + encodeURIComponent(here || 'index.html'));
                return;
            }
            PM.user = session.user;
            PM.role = await run(PM.sb.rpc('my_role'));
            if (!PM.role) {
                PM.showError('帳號尚未開通', `您已登入為 <b>${PM.esc(PM.user.email)}</b>，但此帳號尚未被加入系統成員名單。<br>請聯絡系統管理員到「系統設定 → 成員與權限」新增您的 Email。<br><br><button class="btn btn-secondary" onclick="PM.logout()">登出並切換帳號</button>`);
                return;
            }
            // 離線模式第一次開啟：自動載入示範資料
            if (PM.offline) {
                let seeded = false;
                try { seeded = localStorage.getItem('pm_offline_seeded_v4') === '1'; } catch (e) {}
                if (!seeded) {
                    await seedOfflineDemo();
                    try { localStorage.setItem('pm_offline_seeded_v4', '1'); } catch (e) {}
                }
                showOfflineBanner();
            }
            PM.canEdit = PM.role === 'admin' || PM.role === 'editor';
            PM.isAdmin = PM.role === 'admin';
            document.body.classList.toggle('readonly', !PM.canEdit);
            await PM.reload();
            PM.renderSidebar(active);
            await main();
            hideOverlay();
        } catch (e) {
            console.error(e);
            PM.showError('資料載入失敗', `${PM.esc(PM.errMsg(e))}<br><br>若是第一次部署，請確認已在 Supabase 執行 <code>supabase/schema.sql</code>。<br><br>
                <button class="btn btn-primary" onclick="location.reload()">重新載入</button> <button class="btn btn-secondary" onclick="PM.logout()">登出</button>`);
        }
    };

    function showOfflineBanner() {
        if (document.getElementById('offlineBanner')) return;
        const main = document.querySelector('.main-wrapper');
        if (!main) return;
        const div = document.createElement('div');
        div.id = 'offlineBanner';
        div.className = 'offline-banner';
        const u = window.PMOffline.current();
        div.innerHTML = `🧪 <b>離線測試模式</b>｜目前身分：<b>${PM.esc(u.name)}</b>（可在左下角切換，測試分享與權限）。資料只存在這台電腦的瀏覽器（約 ${window.PMOffline.usageKB()} KB）。
            正式上線請在 <code>assets/config.js</code> 設定 <code>OFFLINE: false</code> 並填入 Supabase 連線資訊。`;
        main.insertBefore(div, main.firstChild);
    }

    if (PM.sb) PM.sb.auth.onAuthStateChange(evt => {
        if (evt === 'SIGNED_OUT' && !/login\.html/.test(location.pathname)) location.replace('login.html');
    });

    /* =================== 全域事件 =================== */
    document.addEventListener('click', e => {
        if (e.target.classList && e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    });

    window.PM = PM;
})();
